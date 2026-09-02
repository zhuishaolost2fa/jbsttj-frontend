import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Button } from '@nutui/nutui-react-taro'
import {
  multipartUploadToOss,
  UploadAbortError,
  type UploadProgress,
  type UploadResult,
  type UploadStage,
} from '../../utils/ossMultipartUpload'
import {
  pickDmGuideFile,
  pickChannel,
  validateDmGuideFile,
  type PickedFile,
} from '../../utils/filePicker'
import { simpleUploadToOss } from '../../utils/simpleUpload'
import { formatBytes, formatDuration, formatSpeed } from '../../utils/format'
import './index.less'

interface ImportDmGuideProps {
  /** 导入成功回调，拿到文件 ID、临时访问链接等完整信息 */
  onSuccess?: (result: UploadResult) => void
}

const STAGE_TEXT: Record<UploadStage, string> = {
  idle: '',
  hashing: '正在校验文件…',
  preparing: '正在准备上传…',
  uploading: '正在上传',
  merging: '正在合并文件…',
  finishing: '正在生成链接…',
  done: '导入成功',
  error: '导入失败',
  canceled: '已取消',
}

/**
 * 导入链路拆成的 5 个可视化步骤。
 * 进度条以「单步」为单位：每一步内部从 0 涨到 100%，
 * 该步完成（进入下一步）时进度条先闪一下满格，再回落到起始值重新开始。
 */
/**
 * 五步指示器。
 *
 * 文案刻意写得中性：H5 走「分片直传 OSS」，小程序走「整文件经后端中转」，
 * 两条链路共用这套指示器，所以不出现「分片」「OSS」这类只对一端成立的说法。
 */
const STEP_META = [
  { stage: 'hashing', label: '校验文件', hint: '计算文件指纹' },
  { stage: 'preparing', label: '准备上传', hint: '申请上传任务' },
  { stage: 'uploading', label: '上传文件', hint: '发送到服务器' },
  { stage: 'merging', label: '写入存储', hint: '服务端落盘入库' },
  { stage: 'finishing', label: '生成链接', hint: '换取访问地址' },
] as const

/** 某一步刚开始时进度条回落到的最小填充值 */
const STEP_START_PCT = 8
/** 非上传步骤在「进行中」时进度条缓动逼近、但不直接顶满的上限（满格留给完成瞬间） */
const STEP_ACTIVE_CAP = 99
/** 步骤完成时进度条闪满格的停留时长，制造「到 100% 再回落」的过渡观感 */
const STEP_FLASH_MS = 280

function ImportDmGuide({ onSuccess }: ImportDmGuideProps) {
  const [stage, setStage] = useState<UploadStage>('idle')
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [fileName, setFileName] = useState('')

  /** 当前进行到的步骤下标（0..4，5 表示全部完成） */
  const [currentStep, setCurrentStep] = useState(0)
  /** 当前步骤进度条填充百分比（单步视角，0..100） */
  const [stepPercent, setStepPercent] = useState(0)
  /** 步骤完成瞬间是否处于「满格闪光」态 */
  const [flashDone, setFlashDone] = useState(false)

  // 用 ref 镜像 currentStep，避免阶段切换 effect 读到过期值
  const stepRef = useRef(0)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 保留原始选择结果：重试时直接复用，不用再唤起一次文件选择 */
  const fileRef = useRef<PickedFile | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const setStep = useCallback((idx: number) => {
    stepRef.current = idx
    setCurrentStep(idx)
  }, [])

  const panelVisible = stage !== 'idle'
  const isBusy =
    stage === 'hashing' ||
    stage === 'preparing' ||
    stage === 'uploading' ||
    stage === 'merging' ||
    stage === 'finishing'

  /* 上传过程中拦截页面关闭，避免用户手滑丢掉几百 MB 的进度 */
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5' || !isBusy) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isBusy])

  /** 阶段切换：处理「上一步满格→下一步回落」的过渡与步骤指示器推进 */
  useEffect(() => {
    if (stage === 'idle') return

    // 全部完成
    if (stage === 'done') {
      setFlashDone(true)
      setStepPercent(100)
      setStep(STEP_META.length)
      return
    }
    // 失败 / 取消：保留当前步骤，不推进
    if (stage === 'error' || stage === 'canceled') {
      return
    }

    const idx = STEP_META.findIndex((s) => s.stage === stage)
    if (idx < 0) return

    if (idx > stepRef.current) {
      // 进入更靠后的步骤：上一步完成 → 闪满格 → 停留后回落到新步骤起点
      if (flashTimer.current) clearTimeout(flashTimer.current)
      setFlashDone(true)
      setStepPercent(100)
      flashTimer.current = setTimeout(() => {
        setFlashDone(false)
        setStep(idx)
        setStepPercent(STEP_START_PCT)
      }, STEP_FLASH_MS)
    } else if (idx < stepRef.current) {
      // 回退（如合并后缺片重传）：直接切到该步，不触发完成闪光
      setFlashDone(false)
      setStep(idx)
      setStepPercent(STEP_START_PCT)
    }
  }, [stage, setStep])

  /** 非上传步骤没有真实进度，用缓动动画把进度条推向 99%，营造「进行中」观感 */
  useEffect(() => {
    if (
      stage === 'hashing' ||
      stage === 'preparing' ||
      stage === 'merging' ||
      stage === 'finishing'
    ) {
      const id = setInterval(() => {
        setStepPercent((p) =>
          p >= STEP_ACTIVE_CAP
            ? p
            : Math.min(STEP_ACTIVE_CAP, p + Math.max(1.5, (STEP_ACTIVE_CAP - p) * 0.18))
        )
      }, 220)
      return () => clearInterval(id)
    }
  }, [stage])

  /** 上传阶段：用真实分片进度驱动进度条（过渡闪光期间不覆盖，保证「满格→回落」观感） */
  useEffect(() => {
    if (stage === 'uploading' && progress && !flashDone) {
      setStepPercent(progress.percent)
    }
  }, [progress, stage, flashDone])

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
  }, [])

  const reset = useCallback(() => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
    setStage('idle')
    setProgress(null)
    setErrorMsg('')
    setFileName('')
    setStep(0)
    setStepPercent(0)
    setFlashDone(false)
    fileRef.current = null
    abortRef.current = null
  }, [setStep])

  /**
   * 发起上传。
   *
   * 按 PickedFile 的形态分派到两条链路：
   *   - `direct`  —— H5：分片 + 预签名 URL 直传 OSS，支持秒传与断点续传
   *   - `relayed` —— 小程序：整文件 multipart 经后端中转，有真实进度、可取消
   *
   * 两条链路返回的 UploadResult 结构一致，下游（匹配剧本 → 填表提交）无需感知差异。
   */
  const startUpload = useCallback(
    async (picked: PickedFile) => {
      fileRef.current = picked
      setFileName(picked.name)
      setErrorMsg('')
      setProgress(null)
      setStep(0)
      setStepPercent(STEP_START_PCT)
      setFlashDone(false)
      setStage('hashing')

      const controller = new AbortController()
      abortRef.current = controller

      const shared = {
        signal: controller.signal,
        onProgress: setProgress,
        onStage: setStage,
      }

      try {
        const result = pickChannel(picked) === 'direct'
          ? await multipartUploadToOss(picked.file!, shared)
          : await simpleUploadToOss(picked, shared)

        onSuccess?.(result)
        Taro.showToast({
          // 秒传时没有真正传数据，给个不一样的反馈，否则用户会怀疑没传成功
          title: result.instant ? '文件已存在，秒传完成' : 'DM 指南导入成功',
          icon: 'success',
        })
        setTimeout(reset, 1500)
      } catch (err: any) {
        if (err instanceof UploadAbortError) {
          reset()
          Taro.showToast({ title: '已取消导入', icon: 'none' })
          return
        }
        setStage('error')
        setErrorMsg(err?.message || '导入失败，请重试')
      }
    },
    [onSuccess, reset]
  )

  const handleImport = useCallback(async () => {
    const picked = await pickDmGuideFile()
    if (!picked) return

    const invalidReason = validateDmGuideFile(picked)
    if (invalidReason) {
      Taro.showToast({ title: invalidReason, icon: 'none', duration: 2500 })
      return
    }

    startUpload(picked)
  }, [startUpload])

  const handleCancel = useCallback(() => {
    Taro.showModal({
      title: '确认取消导入？',
      content: '导入会中断，需要重新开始。',
      confirmText: '确认取消',
      cancelText: '继续上传',
      success: (res) => {
        if (res.confirm) abortRef.current?.abort()
      },
    })
  }, [])

  const handleRetry = useCallback(() => {
    // 重试会带同样的文件指纹重新 init，服务端自动跳过已落盘的分片
    if (fileRef.current) startUpload(fileRef.current)
  }, [startUpload])

  const stepMeta = stage === 'done' ? null : STEP_META[currentStep]
  const barWidth = stage === 'done' ? 100 : stepPercent

  return (
    <View className='import-dm-guide'>
      <Button block type='primary' size='large' disabled={isBusy} onClick={handleImport}>
        {isBusy ? '导入中…' : '📄 导入 DM 指南'}
      </Button>

      {panelVisible && (
        <View className='dm-upload-mask'>
          <View className='dm-upload-panel'>
            {/* ===== 步骤完成指示器 ===== */}
            <View className='dm-steps'>
              {STEP_META.map((s, i) => {
                const status: 'done' | 'active' | 'pending' | 'error' | 'canceled' =
                  stage === 'done' || i < currentStep
                    ? 'done'
                    : i === currentStep
                    ? stage === 'error'
                      ? 'error'
                      : stage === 'canceled'
                        ? 'canceled'
                        : 'active'
                    : 'pending'
                const lineDone = i < currentStep || stage === 'done'
                return (
                  <View className='dm-step' key={s.stage}>
                    {i < STEP_META.length - 1 && (
                      <View className={`dm-step-line${lineDone ? ' is-done' : ''}`} />
                    )}
                    <View className={`dm-step-node is-${status}`}>
                      {status === 'done' ? (
                        <Text className='dm-step-mark'>✓</Text>
                      ) : status === 'error' ? (
                        <Text className='dm-step-mark'>!</Text>
                      ) : status === 'canceled' ? (
                        <Text className='dm-step-mark'>×</Text>
                      ) : (
                        <Text className='dm-step-mark'>{i + 1}</Text>
                      )}
                    </View>
                    <Text className={`dm-step-label is-${status}`}>{s.label}</Text>
                  </View>
                )
              })}
            </View>

            <Text className='dm-upload-title'>
              {stage === 'done'
                ? '🎉 导入成功'
                : stage === 'error'
                  ? '导入失败'
                  : stage === 'canceled'
                    ? '已取消'
                    : stepMeta?.label ?? STAGE_TEXT[stage]}
            </Text>
            <Text className='dm-upload-filename'>{fileName}</Text>

            {stage === 'error' ? (
              <View className='dm-upload-error'>
                <Text className='dm-error-text'>{errorMsg}</Text>
                <Text className='dm-error-tip'>
                  重试会重新导入该文件，不会产生重复记录。
                </Text>
              </View>
            ) : (
              <>
                <View className='dm-progress-track'>
                  <View
                    className={`dm-progress-bar${flashDone ? ' is-flash' : ''}${
                      stage === 'done' ? ' is-done' : ''
                    }`}
                    style={{ width: `${barWidth}%` }}
                  />
                </View>

                <View className='dm-progress-meta'>
                  <Text className='dm-step-current'>
                    {stage === 'done'
                      ? '全部步骤完成'
                      : `${(stepMeta?.label) ?? ''} · ${Math.round(barWidth)}%`}
                  </Text>
                  {progress && (
                    <Text className='dm-size'>
                      {formatBytes(progress.loaded)} / {formatBytes(progress.total)}
                    </Text>
                  )}
                </View>

                {/* 进行中才展示该步骤的提示文案 */}
                {isBusy && stepMeta?.hint && (
                  <Text className='dm-step-hint'>{stepMeta.hint}…</Text>
                )}

                {progress && stage === 'uploading' && (
                  <View className='dm-progress-meta'>
                    <Text className='dm-sub'>
                      {/* 小程序端是整文件一次请求，没有分片概念，别显示「分片 0/1」 */}
                      {progress.totalParts > 1
                        ? `分片 ${progress.uploadedParts}/${progress.totalParts} · `
                        : ''}
                      {formatSpeed(progress.speed)}
                    </Text>
                    <Text className='dm-sub'>
                      剩余 {formatDuration(progress.remainSeconds)}
                    </Text>
                  </View>
                )}
              </>
            )}

            <View className='dm-upload-actions'>
              {stage === 'error' && (
                <>
                  <Button size='small' fill='outline' onClick={reset}>
                    关闭
                  </Button>
                  <Button size='small' type='primary' onClick={handleRetry}>
                    重试
                  </Button>
                </>
              )}
              {isBusy && (
                <Button size='small' fill='outline' onClick={handleCancel}>
                  取消上传
                </Button>
              )}
            </View>
          </View>
        </View>
      )}
    </View>
  )
}

export default ImportDmGuide
