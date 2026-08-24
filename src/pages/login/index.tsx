import { useCallback, useMemo, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useAuth } from '../../store/auth'
import { toFriendlyMessage } from '../../services/auth'
import { HOME_PAGE, PASSWORD_MIN_LENGTH } from '../../constants/auth'
import { usePageMeta } from '../../hooks/usePageMeta'
import './index.less'

type Mode = 'login' | 'register'

/** 邮箱格式校验：和后端 pydantic EmailStr 的宽松程度保持接近即可 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function Login() {
  usePageMeta(
    '登录 · 剧本杀复盘助手',
    '登录后即可导入 DM 主持人手册、参与提问解答并同步你的剧本。'
  )
  const router = useRouter()
  const { login, register } = useAuth()

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [noticeMsg, setNoticeMsg] = useState('')

  const isRegister = mode === 'register'

  /** 登录成功后的去向：优先回到来源页 */
  const redirect = useMemo(() => {
    const raw = router.params?.redirect
    return raw ? decodeURIComponent(raw) : ''
  }, [router.params])

  const switchMode = useCallback((next: Mode) => {
    setMode(next)
    setErrorMsg('')
    setNoticeMsg('')
    setConfirmPassword('')
  }, [])

  /** 表单校验，返回错误文案；通过则返回空串 */
  const validate = useCallback((): string => {
    const mail = email.trim()
    if (!mail) return '请输入邮箱'
    if (!EMAIL_RE.test(mail)) return '邮箱格式不正确'
    if (!password) return '请输入密码'
    if (password.length < PASSWORD_MIN_LENGTH) {
      return `密码至少 ${PASSWORD_MIN_LENGTH} 位`
    }
    if (isRegister && password !== confirmPassword) {
      return '两次输入的密码不一致'
    }
    return ''
  }, [email, password, confirmPassword, isRegister])

  const goAfterAuth = useCallback(() => {
    if (redirect) {
      void Taro.redirectTo({ url: redirect }).catch(() => {
        void Taro.switchTab({ url: redirect }).catch(() => {
          void Taro.reLaunch({ url: HOME_PAGE })
        })
      })
      return
    }
    // 从别的页面跳来的就返回，直接进入登录页（如刷新页面）则回首页
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      void Taro.navigateBack()
    } else {
      void Taro.reLaunch({ url: HOME_PAGE })
    }
  }, [redirect])

  const handleSubmit = useCallback(async () => {
    if (submitting) return

    const invalid = validate()
    if (invalid) {
      setErrorMsg(invalid)
      setNoticeMsg('')
      return
    }

    setErrorMsg('')
    setNoticeMsg('')
    setSubmitting(true)

    try {
      if (isRegister) {
        const result = await register(email, password)
        if (result.loggedIn) {
          Taro.showToast({ title: '注册成功', icon: 'success' })
          setTimeout(goAfterAuth, 600)
        } else {
          // 开启了邮箱验证：留在当前页，切回登录 tab 等用户验证完再登录
          setNoticeMsg(result.message)
          setMode('login')
          setPassword('')
          setConfirmPassword('')
        }
      } else {
        await login(email, password)
        Taro.showToast({ title: '登录成功', icon: 'success' })
        setTimeout(goAfterAuth, 400)
      }
    } catch (err) {
      setErrorMsg(toFriendlyMessage(err))
    } finally {
      setSubmitting(false)
    }
  }, [
    submitting,
    validate,
    isRegister,
    register,
    login,
    email,
    password,
    goAfterAuth,
  ])

  return (
    <View className='login-page'>
      <View className='login-card'>
        <View className='login-brand'>
          <Text className='login-brand-emoji'>🎭</Text>
          <Text className='login-brand-title'>剧本杀复盘助手</Text>
          <Text className='login-brand-sub'>
            {isRegister ? '创建账号，开始记录你的每一场本' : '登录后即可导入与管理 DM 指南'}
          </Text>
        </View>

        <View className='login-tabs'>
          <View
            className={`login-tab ${!isRegister ? 'is-active' : ''}`}
            onClick={() => switchMode('login')}
          >
            登录
          </View>
          <View
            className={`login-tab ${isRegister ? 'is-active' : ''}`}
            onClick={() => switchMode('register')}
          >
            注册
          </View>
        </View>

        <View className='login-form'>
          <View className='form-field'>
            <Text className='field-label'>邮箱</Text>
            <Input
              className='field-input'
              type='text'
              value={email}
              placeholder='you@example.com'
              placeholderClass='field-placeholder'
              confirmType='next'
              onInput={(e) => {
                setEmail(e.detail.value)
                if (errorMsg) setErrorMsg('')
              }}
            />
          </View>

          <View className='form-field'>
            <Text className='field-label'>密码</Text>
            <View className='field-input-wrap'>
              <Input
                className='field-input has-suffix'
                password={!showPassword}
                value={password}
                placeholder={`至少 ${PASSWORD_MIN_LENGTH} 位`}
                placeholderClass='field-placeholder'
                confirmType={isRegister ? 'next' : 'done'}
                onInput={(e) => {
                  setPassword(e.detail.value)
                  if (errorMsg) setErrorMsg('')
                }}
                onConfirm={() => {
                  if (!isRegister) void handleSubmit()
                }}
              />
              <Text
                className='field-suffix'
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? '隐藏' : '显示'}
              </Text>
            </View>
          </View>

          {isRegister && (
            <View className='form-field'>
              <Text className='field-label'>确认密码</Text>
              <Input
                className='field-input'
                password={!showPassword}
                value={confirmPassword}
                placeholder='再输入一次密码'
                placeholderClass='field-placeholder'
                confirmType='done'
                onInput={(e) => {
                  setConfirmPassword(e.detail.value)
                  if (errorMsg) setErrorMsg('')
                }}
                onConfirm={() => void handleSubmit()}
              />
            </View>
          )}

          {!!errorMsg && (
            <View className='form-alert is-error'>
              <Text className='alert-icon'>!</Text>
              <Text className='alert-text'>{errorMsg}</Text>
            </View>
          )}

          {!!noticeMsg && (
            <View className='form-alert is-notice'>
              <Text className='alert-icon'>✓</Text>
              <Text className='alert-text'>{noticeMsg}</Text>
            </View>
          )}

          <View
            className={`submit-btn ${submitting ? 'is-loading' : ''}`}
            onClick={() => void handleSubmit()}
          >
            <Text className='submit-text'>
              {submitting ? '处理中…' : isRegister ? '注册并登录' : '登录'}
            </Text>
          </View>

          <View className='login-switch'>
            <Text className='switch-tip'>
              {isRegister ? '已有账号？' : '还没有账号？'}
            </Text>
            <Text
              className='switch-link'
              onClick={() => switchMode(isRegister ? 'login' : 'register')}
            >
              {isRegister ? '去登录' : '立即注册'}
            </Text>
          </View>
        </View>
      </View>
    </View>
  )
}

export default Login
