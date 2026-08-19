/**
 * 微信风格头像编辑器。
 *
 * 交互对标微信：全屏暗色蒙层 + 居中圆形取景框（框外变暗），
 * 用户可对所选图片进行：
 *   - 单指拖动：平移图片
 *   - 双指捏合：缩放（1~3 倍）
 *   - 底部滑块：精调缩放，作为捏合之外的可靠控制
 * 确认后把取景框内的圆形区域绘制到离屏 canvas，导出为 JPEG Blob 回传。
 *
 * 当前实现面向 H5（canvas.toBlob + DOM Image）；小程序环境需另接 2d canvas 节点。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Image, Slider } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.less'

interface Props {
  /** 待编辑的图片地址（chooseMedia 返回的临时路径 / blob URL） */
  src: string
  onCancel: () => void
  /** 导出裁剪后的头像 Blob */
  onConfirm: (blob: Blob) => void | Promise<void>
}

const FRAME = 260 // 预览圆形直径(px)，需与 .less 中的 .ae-frame 尺寸一致
const EXPORT = 400 // 导出图边长(px)
const MIN_SCALE = 1
const MAX_SCALE = 3

interface ImgSize {
  natW: number
  natH: number
  baseScale: number
}

interface StateSnap {
  scale: number
  tx: number
  ty: number
}

export default function AvatarEditor({ src, onCancel, onConfirm }: Props) {
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [size, setSize] = useState<ImgSize>({ natW: FRAME, natH: FRAME, baseScale: 1 })
  const [ready, setReady] = useState(false)
  const [uploading, setUploading] = useState(false)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null)
  // 触摸事件回调是合成事件，闭包里的 state 可能过期，用 ref 镜像最新值
  const stateRef = useRef<StateSnap>({ scale, tx, ty })
  stateRef.current = { scale, tx, ty }

  useEffect(() => {
    if (typeof document === 'undefined') return
    const img = document.createElement('img')
    img.onload = () => {
      // cover 思路：以较短边铺满取景框，超出的部分交给圆形裁剪
      const baseScale = FRAME / Math.min(img.naturalWidth, img.naturalHeight)
      setSize({ natW: img.naturalWidth, natH: img.naturalHeight, baseScale })
      setScale(1)
      setTx(0)
      setTy(0)
      setReady(true)
    }
    img.src = src
    imgRef.current = img
    return () => {
      img.onload = null
    }
  }, [src])

  const drawnSize = () => ({
    w: size.natW * size.baseScale,
    h: size.natH * size.baseScale,
  })

  const clamp = useCallback(
    (s: number, x: number, y: number) => {
      const { w, h } = drawnSize()
      // 限制平移，保证图片始终覆盖整个圆形取景框（边缘不能缩进框内）
      const maxX = Math.max(0, w / 2 - FRAME / 2)
      const maxY = Math.max(0, h / 2 - FRAME / 2)
      return {
        s: Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)),
        x: Math.min(maxX, Math.max(-maxX, x)),
        y: Math.min(maxY, Math.max(-maxY, y)),
      }
    },
    [size]
  )

  const onTouchStart = (e: any) => {
    if (e.touches.length === 1) {
      const t = e.touches[0]
      dragRef.current = { x: t.clientX, y: t.clientY, tx: stateRef.current.tx, ty: stateRef.current.ty }
    } else if (e.touches.length === 2) {
      dragRef.current = null
      const [a, b] = e.touches
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      pinchRef.current = { dist, scale: stateRef.current.scale }
    }
  }

  const onTouchMove = (e: any) => {
    if (e.touches.length === 1 && dragRef.current) {
      const t = e.touches[0]
      const nx = dragRef.current.tx + (t.clientX - dragRef.current.x)
      const ny = dragRef.current.ty + (t.clientY - dragRef.current.y)
      const c = clamp(stateRef.current.scale, nx, ny)
      setTx(c.x)
      setTy(c.y)
    } else if (e.touches.length === 2 && pinchRef.current) {
      const [a, b] = e.touches
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const ratio = dist / (pinchRef.current.dist || dist)
      const c = clamp(pinchRef.current.scale * ratio, stateRef.current.tx, stateRef.current.ty)
      setScale(c.s)
    }
  }

  const onTouchEnd = () => {
    dragRef.current = null
    pinchRef.current = null
  }

  const onSlider = (v: number) => {
    const c = clamp(v, stateRef.current.tx, stateRef.current.ty)
    setScale(c.s)
  }

  const handleConfirm = () => {
    const img = imgRef.current
    if (!img || !ready || uploading) return
    if (typeof document === 'undefined') {
      Taro.showToast({ title: '当前环境暂不支持头像裁剪', icon: 'none' })
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = EXPORT
    canvas.height = EXPORT
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, EXPORT, EXPORT)
    ctx.save()
    ctx.beginPath()
    ctx.arc(EXPORT / 2, EXPORT / 2, EXPORT / 2, 0, Math.PI * 2)
    ctx.clip()
    const s = EXPORT / FRAME
    const { w, h } = drawnSize()
    const drawnW = w * scale
    const drawnH = h * scale
    const cx = (FRAME / 2 + tx) * s
    const cy = (FRAME / 2 + ty) * s
    ctx.drawImage(img, cx - drawnW / 2, cy - drawnH / 2, drawnW, drawnH)
    ctx.restore()

    setUploading(true)
    canvas.toBlob(
      (blob) => {
        if (blob) {
          Promise.resolve(onConfirm(blob)).finally(() => setUploading(false))
        } else {
          setUploading(false)
          Taro.showToast({ title: '头像处理失败，请重试', icon: 'none' })
        }
      },
      'image/jpeg',
      0.9
    )
  }

  const { w, h } = drawnSize()

  return (
    <View className='avatar-editor'>
      <View
        className='ae-stage'
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <View className='ae-frame'>
          {ready && (
            <Image
              className='ae-img'
              src={src}
              style={{
                width: `${w}px`,
                height: `${h}px`,
                marginLeft: `${-w / 2}px`,
                marginTop: `${-h / 2}px`,
                transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              }}
            />
          )}
        </View>
      </View>

      <View className='ae-bar'>
        <View className='ae-btn' onClick={onCancel}>
          <Text>取消</Text>
        </View>
        <Slider
          className='ae-slider'
          min={MIN_SCALE}
          max={MAX_SCALE}
          step={0.01}
          value={scale}
          onChange={(e) => onSlider(e.detail.value)}
          blockSize={20}
        />
        <View className='ae-btn primary' onClick={handleConfirm}>
          <Text>{uploading ? '处理中…' : '选取'}</Text>
        </View>
      </View>
    </View>
  )
}
