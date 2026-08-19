/**
 * 编辑资料页。
 *
 * 交互对标主流 App：
 *   - 头像：渐变色板一键切换（与默认头像思路一致）+ 自定义图片链接 + 恢复默认
 *   - 昵称 / 简介：实时字数计数，超长拦截
 *   - 性别：分段控件，单选
 *   - 生日：原生日期选择器，上限为今天
 *   - 地区：省 → 市二级联动选择器
 *   - 脏检测：未改动时保存按钮置灰
 *   - 乐观并发：带上 GET 拿到的 updated_at（If-Match），服务端冲突返回 409 时提示刷新后重试
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Input, Textarea, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import Avatar from '../../../components/Avatar'
import AvatarEditor from '../../../components/AvatarEditor'
import { AVATAR_THEMES } from '../../../constants/avatar'
import { REGION_DATA, parseRegion } from '../../../constants/regions'
import { useAuth } from '../../../store/auth'
import {
  fetchProfile,
  updateProfile,
  uploadAvatar,
  toFriendlyMessage,
  type Gender,
  type Profile,
  type ProfilePatch,
} from '../../../services/auth'
import './index.less'

const NICKNAME_MAX = 30
const BIO_MAX = 120

interface FormState {
  nickname: string
  avatarUrl: string
  avatarColor: number
  bio: string
  gender: Gender | ''
  birthday: string
  region: string
}

function todayStr(): string {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function profileToForm(p: Profile): FormState {
  return {
    nickname: p.nickname ?? '',
    avatarUrl: p.avatar_url ?? '',
    avatarColor: typeof p.avatar_color === 'number' ? p.avatar_color : 0,
    bio: p.bio ?? '',
    gender: (p.gender ?? '') as Gender | '',
    birthday: p.birthday ?? '',
    region: p.region ?? '',
  }
}

function formToForm(userForm: {
  nickname?: string | null
  avatarUrl?: string | null
  avatarColor?: number | null
  bio?: string | null
  gender?: Gender | null
  birthday?: string | null
  region?: string | null
}): FormState {
  return {
    nickname: userForm.nickname ?? '',
    avatarUrl: userForm.avatarUrl ?? '',
    avatarColor: userForm.avatarColor ?? 0,
    bio: userForm.bio ?? '',
    gender: (userForm.gender ?? '') as Gender | '',
    birthday: userForm.birthday ?? '',
    region: userForm.region ?? '',
  }
}

function findRegionIndices(region: string): [number, number] {
  const [prov, city] = parseRegion(region)
  const pIndex = Math.max(0, REGION_DATA.findIndex((p) => p.name === prov))
  const cIndex = Math.max(0, REGION_DATA[pIndex].cities.indexOf(city))
  return [pIndex, cIndex]
}

const GENDER_OPTIONS: Array<{ value: Gender; label: string }> = [
  { value: 'male', label: '男' },
  { value: 'female', label: '女' },
  { value: 'other', label: '保密' },
]

export default function EditProfilePage() {
  const { user, refreshUser } = useAuth()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<FormState>(() => formToForm(user || {}))
  const [initial, setInitial] = useState<FormState>(() => formToForm(user || {}))
  const [ifMatch, setIfMatch] = useState<string | null>(null)

  // 地区联动选择器的列索引
  const [regionIdx, setRegionIdx] = useState<[number, number]>([0, 0])

  // 头像编辑器：选图后弹起，裁剪确认后再上传
  const [editorSrc, setEditorSrc] = useState<string | null>(null)

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  // 进入页面时拉一次最新资料（拿 updated_at 作为乐观并发令牌，也避免用陈旧缓存）
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchProfile()
      .then((p) => {
        if (cancelled) return
        const f = profileToForm(p)
        setForm(f)
        setInitial(f)
        setIfMatch(p.updated_at ?? null)
        setRegionIdx(findRegionIndices(f.region))
      })
      .catch(() => {
        if (cancelled) return
        // 拉取失败（如网络问题）就退化为本地缓存，跳过 If-Match 防冲突
        const f = formToForm(user || {})
        setForm(f)
        setInitial(f)
        setRegionIdx(findRegionIndices(f.region))
        setIfMatch(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isDirty = useMemo(() => {
    return (
      form.nickname !== initial.nickname ||
      form.avatarUrl !== initial.avatarUrl ||
      form.avatarColor !== initial.avatarColor ||
      form.bio !== initial.bio ||
      form.gender !== initial.gender ||
      form.birthday !== initial.birthday ||
      form.region !== initial.region
    )
  }, [form, initial])

  const avatarName = form.nickname || user?.email || '我'

  const applyColor = (idx: number) => {
    set('avatarColor', idx)
    set('avatarUrl', '') // 选了色板就放弃自定义图片，露出渐变头像
  }

  const applyCustomUrl = (value: string) => {
    const url = value.trim()
    if (url && !/^https?:\/\//i.test(url)) {
      Taro.showToast({ title: '头像链接需以 http(s):// 开头', icon: 'none' })
      return
    }
    set('avatarUrl', url)
  }

  const resetAvatar = () => {
    set('avatarColor', 0)
    set('avatarUrl', '')
  }

  /** 从相册 / 相机选择图片，进入微信式头像裁剪 */
  const handleChooseImage = () => {
    Taro.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original', 'compressed'],
    })
      .then((res) => {
        const p = res.tempFiles?.[0]?.tempFilePath
        if (p) setEditorSrc(p)
      })
      .catch(() => {
        /* 用户取消或不支持，静默 */
      })
  }

  /** 裁剪确认后上传，并同步本地表单与全局用户 */
  const handleAvatarConfirm = async (blob: Blob) => {
    try {
      const updated = await uploadAvatar(blob)
      const url = updated.avatar_url || ''
      setForm((prev) => ({ ...prev, avatarUrl: url, avatarColor: 0 }))
      setInitial((prev) => ({ ...prev, avatarUrl: url, avatarColor: 0 }))
      // 头像已通过 PATCH 落库，updated_at 已变化；同步乐观并发令牌，避免随后点「保存」时 409
      setIfMatch(updated.updated_at ?? null)
      await refreshUser() // 同步全局，个人中心与个人页立刻生效
      Taro.showToast({ title: '头像已更新', icon: 'success' })
    } catch (err) {
      Taro.showToast({ title: toFriendlyMessage(err), icon: 'none', duration: 2500 })
    } finally {
      setEditorSrc(null)
    }
  }

  const onRegionChange = (e: any) => {
    const [pIndex, cIndex] = e.detail.value as number[]
    setRegionIdx([pIndex, cIndex])
    const city = REGION_DATA[pIndex].cities[cIndex] || ''
    set('region', city ? `${REGION_DATA[pIndex].name} ${city}` : REGION_DATA[pIndex].name)
  }

  const onRegionColumnChange = (e: any) => {
    const { column, value } = e.detail
    if (column === 0) {
      setRegionIdx([value, 0]) // 省份变了，城市归零
    } else {
      setRegionIdx((prev) => [prev[0], value])
    }
  }

  const handleSave = async () => {
    if (saving) return
    const nickname = form.nickname.trim()
    if (!nickname) {
      Taro.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }
    if (nickname.length > NICKNAME_MAX) {
      Taro.showToast({ title: `昵称最多 ${NICKNAME_MAX} 字`, icon: 'none' })
      return
    }

    const patch: ProfilePatch = {
      nickname,
      avatar_url: form.avatarUrl || null,
      avatar_color: form.avatarColor,
      bio: form.bio || null,
      gender: form.gender || null,
      birthday: form.birthday || null,
      region: form.region || null,
    }

    setSaving(true)
    try {
      await updateProfile(patch, ifMatch)
      await refreshUser() // 同步全局用户，个人中心立即生效
      Taro.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 400)
    } catch (err) {
      const apiErr = err as { code?: string }
      if (apiErr?.code === 'stale_profile') {
        // 乐观并发冲突：刷新资料后让用户重新编辑
        Taro.showModal({
          title: '资料已更新',
          content: '你的资料在其他设备被修改过，已为你载入最新内容，请确认后再次保存。',
          showCancel: false,
        }).then(() => {
          fetchProfile()
            .then((p) => {
              const f = profileToForm(p)
              setForm(f)
              setInitial(f)
              setIfMatch(p.updated_at ?? null)
              setRegionIdx(findRegionIndices(f.region))
            })
            .catch(() => {
              /* 拉取失败就保持当前表单 */
            })
        })
      } else {
        Taro.showToast({ title: toFriendlyMessage(err), icon: 'none', duration: 2500 })
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <View className='edit-loading'>
        <Text>加载中…</Text>
      </View>
    )
  }

  const provinceNames = REGION_DATA.map((p) => p.name)
  const cityNames = REGION_DATA[regionIdx[0]].cities
  const regionText = form.region || '未设置'

  return (
    <View className='edit-page'>
      {/* ===== 头像 ===== */}
      <View className='section'>
        <Text className='section-title'>头像</Text>
        <View className='avatar-row'>
          <Avatar name={avatarName} url={form.avatarUrl || null} color={form.avatarColor} size={64} />
          <View className='avatar-actions'>
            <View className='avatar-upload' onClick={handleChooseImage}>
              <Text>从相册选择</Text>
            </View>
            <Text className='avatar-tip'>或选择色板 / 填写图片链接</Text>
            <View className='swatches'>
              {AVATAR_THEMES.map((theme, idx) => (
                <View
                  key={idx}
                  className={`swatch${form.avatarUrl ? '' : form.avatarColor === idx ? ' is-active' : ''}`}
                  style={{ background: theme.gradient }}
                  onClick={() => applyColor(idx)}
                />
              ))}
            </View>
            <View className='url-input'>
              <Input
                className='url-input-field'
                placeholder='自定义头像图片链接（http/https）'
                value={form.avatarUrl}
                onInput={(e) => set('avatarUrl', e.detail.value)}
                onBlur={(e) => applyCustomUrl(e.detail.value)}
              />
              <View className='url-reset' onClick={resetAvatar}>
                <Text>恢复默认</Text>
              </View>
            </View>
          </View>
        </View>
      </View>

      {/* ===== 基础资料 ===== */}
      <View className='section'>
        <Text className='section-title'>基础资料</Text>

        <View className='field'>
          <Text className='field-label'>昵称</Text>
          <View className='field-control'>
            <Input
              className='text-input'
              placeholder='给自己起个名字'
              maxlength={NICKNAME_MAX}
              value={form.nickname}
              onInput={(e) => set('nickname', e.detail.value)}
            />
            <Text className='counter'>{form.nickname.length}/{NICKNAME_MAX}</Text>
          </View>
        </View>

        <View className='field'>
          <Text className='field-label'>性别</Text>
          <View className='segment'>
            {GENDER_OPTIONS.map((opt) => (
              <View
                key={opt.value}
                className={`segment-item${form.gender === opt.value ? ' is-active' : ''}`}
                onClick={() => set('gender', opt.value)}
              >
                <Text>{opt.label}</Text>
              </View>
            ))}
          </View>
        </View>

        <View className='field'>
          <Text className='field-label'>生日</Text>
          <Picker mode='date' end={todayStr()} value={form.birthday} onChange={(e) => set('birthday', e.detail.value)}>
            <View className='picker-control'>
              <Text className={form.birthday ? '' : 'placeholder'}>{form.birthday || '选择生日'}</Text>
              <Text className='picker-arrow'>&#x203A;</Text>
            </View>
          </Picker>
        </View>

        <View className='field'>
          <Text className='field-label'>地区</Text>
          <Picker
            mode='multiSelector'
            range={[provinceNames, cityNames]}
            value={regionIdx}
            onColumnChange={onRegionColumnChange}
            onChange={onRegionChange}
          >
            <View className='picker-control'>
              <Text className={form.region ? '' : 'placeholder'}>{regionText}</Text>
              <Text className='picker-arrow'>&#x203A;</Text>
            </View>
          </Picker>
        </View>
      </View>

      {/* ===== 简介 ===== */}
      <View className='section'>
        <Text className='section-title'>个人简介</Text>
        <View className='bio-box'>
          <Textarea
            className='bio-input'
            placeholder='介绍一下自己，让带本更有趣（选填）'
            maxlength={BIO_MAX}
            value={form.bio}
            onInput={(e) => set('bio', e.detail.value)}
          />
          <Text className='counter bio-counter'>{form.bio.length}/{BIO_MAX}</Text>
        </View>
      </View>

      {/* ===== 底部保存 ===== */}
      <View className='footer'>
        <View
          className={`save-btn${isDirty && !saving ? ' is-ready' : ''}`}
          onClick={handleSave}
        >
          <Text>{saving ? '保存中…' : isDirty ? '保存' : '无改动'}</Text>
        </View>
      </View>

      {editorSrc && (
        <AvatarEditor src={editorSrc} onCancel={() => setEditorSrc(null)} onConfirm={handleAvatarConfirm} />
      )}
    </View>
  )
}
