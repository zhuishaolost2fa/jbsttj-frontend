import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useAuth } from '../../store/auth'
import { toFriendlyMessage } from '../../services/auth'
import { ApiError } from '../../services/request'
import {
  EMAIL_OTP_LENGTH,
  HOME_PAGE,
  IS_WEAPP,
  PASSWORD_MIN_LENGTH,
  RESEND_COOLDOWN_SECONDS,
} from '../../constants/auth'
import { usePageMeta } from '../../hooks/usePageMeta'
import AppIcon from '../../components/AppIcon'
import './index.less'

/**
 * login=登录 / register=注册 / verify=填写邮箱验证码。
 *
 * verify 之所以必须有：发信走腾讯云 SES，其模板审核规范不接受「整条链接做成
 * 变量」，通过审核的模板只能展示纯数字验证码 —— 邮件里**没有可点链接**，
 * 注册就必须在前端这一步收验证码。
 */
type Mode = 'login' | 'register' | 'verify'
/** 小程序端有两种入口：微信一键登录 / 邮箱密码。H5 端恒为 password */
type Entry = 'wechat' | 'password'

/** 邮箱格式校验：和后端 pydantic EmailStr 的宽松程度保持接近即可 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** 验证码只允许纯数字：GoTrue 的 mailer_otp 是数字，过滤掉误粘造成的空格 */
function normalizeOtp(raw: string): string {
  return (raw || '').replace(/\D/g, '').slice(0, EMAIL_OTP_LENGTH)
}

function Login() {
  usePageMeta(
    '登录 · 剧本杀复盘助手',
    '登录后即可导入 DM 主持人手册、参与提问解答并同步你的剧本。'
  )
  const router = useRouter()
  const {
    login,
    register,
    verifyEmail,
    resendSignupCode,
    loginWithWechat,
  } = useAuth()

  const [entry, setEntry] = useState<Entry>(IS_WEAPP ? 'wechat' : 'password')
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [otp, setOtp] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [noticeMsg, setNoticeMsg] = useState('')

  const isRegister = mode === 'register'
  const isVerify = mode === 'verify'
  /** 小程序端且未切到「邮箱密码」时，只渲染微信一键登录 */
  const showWechat = IS_WEAPP && entry === 'wechat'
  const showPasswordForm = !showWechat && !isVerify

  /** 登录成功后的去向：优先回到来源页 */
  const redirect = useMemo(() => {
    const raw = router.params?.redirect
    return raw ? decodeURIComponent(raw) : ''
  }, [router.params])

  const switchEntry = useCallback((next: Entry) => {
    setEntry(next)
    setErrorMsg('')
    setNoticeMsg('')
  }, [])

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

  /** 重发验证码倒计时 */
  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((v) => v - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  /** 提交邮箱验证码，成功后建立登录态并跳转 */
  const handleVerifyOtp = useCallback(async () => {
    if (submitting) return
    if (otp.length !== EMAIL_OTP_LENGTH) {
      setErrorMsg(`请输入 ${EMAIL_OTP_LENGTH} 位验证码`)
      return
    }

    setErrorMsg('')
    setNoticeMsg('')
    setSubmitting(true)

    try {
      await verifyEmail(email, otp, 'signup')
      Taro.showToast({ title: '验证成功', icon: 'success' })
      setTimeout(goAfterAuth, 400)
    } catch (err) {
      // 邮箱其实早就验证过了（用户拿旧邮件里的码来兑）：回登录表单而不是干等
      if (err instanceof ApiError && err.code === 'email_already_verified') {
        setMode('login')
        setOtp('')
        setCountdown(0)
      }
      setErrorMsg(toFriendlyMessage(err))
    } finally {
      setSubmitting(false)
    }
  }, [submitting, otp, verifyEmail, email, goAfterAuth])

  /**
   * 重发验证码。
   * GoTrue 对同一邮箱有 60 秒冷却，倒计时期间点了也没用，直接禁用按钮。
   */
  const handleResendCode = useCallback(async () => {
    if (submitting || countdown > 0) return

    setErrorMsg('')
    setNoticeMsg('')
    setSubmitting(true)

    try {
      await resendSignupCode(email)
      setCountdown(RESEND_COOLDOWN_SECONDS)
      setNoticeMsg(`验证码已重新发送，请查收 ${email.trim()}`)
    } catch (err) {
      // 邮箱早就验证过了：继续待在验证码页没意义，直接把人送回登录表单
      if (err instanceof ApiError && err.code === 'email_already_verified') {
        setMode('login')
        setOtp('')
        setCountdown(0)
        setNoticeMsg('')
      }
      setErrorMsg(toFriendlyMessage(err))
    } finally {
      setSubmitting(false)
    }
  }, [submitting, countdown, resendSignupCode, email])

  const handleWechatLogin = useCallback(async () => {
    if (submitting) return

    setErrorMsg('')
    setNoticeMsg('')
    setSubmitting(true)

    try {
      await loginWithWechat()
      Taro.showToast({ title: '登录成功', icon: 'success' })
      setTimeout(goAfterAuth, 400)
    } catch (err) {
      setErrorMsg(toFriendlyMessage(err))
    } finally {
      setSubmitting(false)
    }
  }, [submitting, loginWithWechat, goAfterAuth])

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
          // 开启了邮箱验证：切到验证码视图，验证完直接就有登录态，不用再登一次
          setNoticeMsg(result.message)
          setMode('verify')
          setOtp('')
          setCountdown(RESEND_COOLDOWN_SECONDS)
          setPassword('')
          setConfirmPassword('')
        }
      } else {
        await login(email, password)
        Taro.showToast({ title: '登录成功', icon: 'success' })
        setTimeout(goAfterAuth, 400)
      }
    } catch (err) {
      // 已注册且已验证的邮箱再注册，后端会拦成 409 —— 引导去登录，别停在注册页
      if (err instanceof ApiError && err.code === 'email_already_verified') {
        setMode('login')
        setOtp('')
        setCountdown(0)
      }
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
          {/* 品牌标记：墨底 + 品牌黄字，不用 emoji（小程序端可能掉字） */}
          <View className='login-brand-mark'>
            <Text className='login-brand-mark-text'>剧</Text>
          </View>
          <Text className='login-brand-title'>剧本杀复盘助手</Text>
          <Text className='login-brand-sub'>
            {showWechat
              ? '使用微信身份一键登录，无需注册'
              : isVerify
                ? '邮件里没有验证链接，请在此填写验证码'
                : isRegister
                  ? '创建账号，开始记录你的每一场本'
                  : '登录后即可导入与管理 DM 指南'}
          </Text>
        </View>

        {/* 微信小程序：一键登录为主入口 */}
        {showWechat && (
          <View className='login-form'>
            <View
              className={`wx-btn ${submitting ? 'is-loading' : ''}`}
              onClick={() => void handleWechatLogin()}
            >
              <Text className='wx-btn-text'>
                {submitting ? '登录中…' : '微信一键登录'}
              </Text>
            </View>

            {!!errorMsg && (
              <View className='form-alert is-error'>
                <AppIcon name='alert-circle' tone='danger' size={15} className='alert-icon' />
                <Text className='alert-text'>{errorMsg}</Text>
              </View>
            )}

            <View className='login-switch'>
              <Text
                className='switch-link'
                onClick={() => switchEntry('password')}
              >
                使用邮箱密码登录
              </Text>
            </View>
          </View>
        )}

        {showPasswordForm && (
          <>
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
                  <AppIcon name='alert-circle' tone='danger' size={15} className='alert-icon' />
                  <Text className='alert-text'>{errorMsg}</Text>
                </View>
              )}

              {!!noticeMsg && (
                <View className='form-alert is-notice'>
                  <AppIcon name='check-circle' tone='ink' size={15} className='alert-icon' />
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

              {/* 小程序端邮箱登录是次级入口，给一条回微信登录的路 */}
              {IS_WEAPP && (
                <View className='login-switch is-secondary'>
                  <Text
                    className='switch-link'
                    onClick={() => switchEntry('wechat')}
                  >
                    使用微信一键登录
                  </Text>
                </View>
              )}
            </View>
          </>
        )}

        {/* ===== 邮箱验证码：注册的最后一步 =====
            邮件里只有纯数字验证码没有链接（腾讯云模板审核规范不接受链接做变量），
            所以这一步是强制的，成功后直接签发会话。 */}
        {isVerify && (
          <View className='login-form'>
            <View className='verify-target'>
              <AppIcon name='inbox' tone='ink' size={15} className='verify-mail-icon' />
              <Text className='verify-target-text'>{email.trim()}</Text>
            </View>

            <View className='form-field'>
              <Text className='field-label'>邮箱验证码</Text>
              <Input
                className='otp-input'
                type='number'
                value={otp}
                maxlength={EMAIL_OTP_LENGTH}
                placeholder={`${EMAIL_OTP_LENGTH} 位数字`}
                placeholderClass='otp-placeholder'
                confirmType='done'
                onInput={(e) => {
                  setOtp(normalizeOtp(e.detail.value))
                  if (errorMsg) setErrorMsg('')
                }}
                onConfirm={() => void handleVerifyOtp()}
              />
              <View className='otp-hint-row'>
                <Text className='otp-count'>{otp.length}/{EMAIL_OTP_LENGTH}</Text>
                <Text
                  className={`resend-btn ${countdown > 0 ? 'is-disabled' : ''}`}
                  onClick={() => void handleResendCode()}
                >
                  {countdown > 0 ? `${countdown}s 后重发` : '重新发送'}
                </Text>
              </View>
            </View>

            {!!errorMsg && (
              <View className='form-alert is-error'>
                <AppIcon name='alert-circle' tone='danger' size={15} className='alert-icon' />
                <Text className='alert-text'>{errorMsg}</Text>
              </View>
            )}

            {!!noticeMsg && (
              <View className='form-alert is-notice'>
                <AppIcon name='check-circle' tone='ink' size={15} className='alert-icon' />
                <Text className='alert-text'>{noticeMsg}</Text>
              </View>
            )}

            <View
              className={`submit-btn ${submitting ? 'is-loading' : ''}`}
              onClick={() => void handleVerifyOtp()}
            >
              <Text className='submit-text'>
                {submitting ? '验证中…' : '完成验证'}
              </Text>
            </View>

            <View className='login-switch'>
              <Text
                className='switch-link'
                onClick={() => switchMode('register')}
              >
                换个邮箱重新注册
              </Text>
            </View>
          </View>
        )}
      </View>
    </View>
  )
}

export default Login
