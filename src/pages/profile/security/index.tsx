/**
 * 账号与安全页。
 *
 * 页面结构随账号状态变化，三种情况：
 *
 *   1. 微信用户（未绑邮箱）
 *      → 绑定邮箱（验证码两步）+ 设置登录密码
 *      绑完这两步，账号就从「换设备即失联」变成可找回的常规账号
 *   2. 微信用户（已绑邮箱）
 *      → 显示真实邮箱，可修改密码
 *   3. 邮箱用户
 *      → 修改密码 / 修改邮箱；小程序端额外提供「绑定微信」
 *
 * 微信用户原先整块隐藏改密 / 改邮箱入口 —— 那时登录走「确定性密码」，
 * 改密码会被下次微信登录覆盖。现在登录改走免密签发，密码与微信互不干扰，
 * 所以这些入口可以安全开放。
 */

import { useCallback, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useAuth } from '../../../store/auth'
import {
  changePassword,
  changeEmail,
  confirmBindEmail,
  setPassword,
  startBindEmail,
  toFriendlyMessage,
} from '../../../services/auth'
import { IS_WEAPP, PASSWORD_MIN_LENGTH } from '../../../constants/auth'
import { usePageMeta } from '../../../hooks/usePageMeta'
import './index.less'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function passwordStrength(password: string): { level: 0 | 1 | 2 | 3; tip: string } {
  if (!password) return { level: 0, tip: '' }
  let score = 0
  if (password.length >= PASSWORD_MIN_LENGTH) score++
  if (password.length >= 10) score++
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++
  if (score <= 1) return { level: 1, tip: '弱：建议混合字母、数字和符号' }
  if (score <= 2) return { level: 2, tip: '中：再加点复杂度更安全' }
  return { level: 3, tip: '强：这个密码不错' }
}

export default function SecurityPage() {
  usePageMeta(
    '账号安全 · 剧本杀复盘助手',
    '绑定邮箱、设置密码与绑定微信，保护你的账号与导入记录。'
  )
  const { user, bindWechat } = useAuth()

  const [curPwd, setCurPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [newEmail, setNewEmail] = useState('')

  const [showCur, setShowCur] = useState(false)
  const [showNew, setShowNew] = useState(false)

  // 绑定邮箱：两步（已发信 → 等验证码）
  const [bindEmailInput, setBindEmailInput] = useState('')
  const [bindCode, setBindCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [sentTo, setSentTo] = useState('')

  const [pwdBusy, setPwdBusy] = useState(false)
  const [emailBusy, setEmailBusy] = useState(false)
  const [bindBusy, setBindBusy] = useState(false)
  const [wxBusy, setWxBusy] = useState(false)

  const strength = passwordStrength(newPwd)

  const isWechatUser = user?.provider === 'wechat'
  const wechatBound = !!user?.wechatBound
  const verified = !!user?.emailVerified

  /**
   * 是否为占位邮箱（wx_xxx@wechat.local）。
   * 微信用户绑定真实邮箱之前，后端给的是占位邮箱，展示它没有意义，
   * 而且看起来像 bug —— 直接显示「微信一键登录」。
   */
  const hasRealEmail = !!user?.email && !user.email.endsWith('@wechat.local')

  const submitPassword = useCallback(async () => {
    if (pwdBusy) return
    if (!isWechatUser && !curPwd) {
      Taro.showToast({ title: '请先输入当前密码', icon: 'none' })
      return
    }
    if (newPwd.length < PASSWORD_MIN_LENGTH) {
      Taro.showToast({ title: `新密码至少 ${PASSWORD_MIN_LENGTH} 位`, icon: 'none' })
      return
    }
    if (newPwd !== confirmPwd) {
      Taro.showToast({ title: '两次输入的新密码不一致', icon: 'none' })
      return
    }

    setPwdBusy(true)
    try {
      const res = isWechatUser
        ? await setPassword(newPwd)
        : await changePassword(curPwd, newPwd)
      Taro.showToast({ title: res.message || '密码已更新', icon: 'success' })
      setCurPwd('')
      setNewPwd('')
      setConfirmPwd('')
    } catch (err) {
      Taro.showToast({ title: toFriendlyMessage(err), icon: 'none', duration: 2500 })
    } finally {
      setPwdBusy(false)
    }
  }, [pwdBusy, curPwd, newPwd, confirmPwd, isWechatUser])

  const submitEmail = useCallback(async () => {
    if (emailBusy) return
    if (!curPwd) {
      Taro.showToast({ title: '请先输入当前密码', icon: 'none' })
      return
    }
    const email = newEmail.trim().toLowerCase()
    if (!EMAIL_RE.test(email)) {
      Taro.showToast({ title: '请输入有效的邮箱地址', icon: 'none' })
      return
    }
    if (user?.email && email === user.email.toLowerCase()) {
      Taro.showToast({ title: '新邮箱不能与当前邮箱相同', icon: 'none' })
      return
    }

    setEmailBusy(true)
    try {
      const res = await changeEmail(curPwd, newEmail)
      Taro.showToast({ title: res.message || '验证邮件已发送', icon: 'none', duration: 2500 })
      setNewEmail('')
    } catch (err) {
      Taro.showToast({ title: toFriendlyMessage(err), icon: 'none', duration: 2500 })
    } finally {
      setEmailBusy(false)
    }
  }, [emailBusy, curPwd, newEmail, user?.email])

  /** 第 1 步：发验证码 */
  const sendBindCode = useCallback(async () => {
    if (bindBusy) return
    const email = bindEmailInput.trim().toLowerCase()
    if (!EMAIL_RE.test(email)) {
      Taro.showToast({ title: '请输入有效的邮箱地址', icon: 'none' })
      return
    }
    setBindBusy(true)
    try {
      await startBindEmail(email)
      setSentTo(email)
      setCodeSent(true)
      Taro.showToast({ title: '验证码已发送，请查收邮件', icon: 'none', duration: 2500 })
    } catch (err) {
      Taro.showToast({ title: toFriendlyMessage(err), icon: 'none', duration: 2500 })
    } finally {
      setBindBusy(false)
    }
  }, [bindBusy, bindEmailInput])

  /** 第 2 步：校验验证码并改邮箱 */
  const doBindEmail = useCallback(async () => {
    if (bindBusy) return
    if (bindCode.trim().length < 4) {
      Taro.showToast({ title: '请输入邮件中的验证码', icon: 'none' })
      return
    }
    setBindBusy(true)
    try {
      await confirmBindEmail(sentTo, bindCode)
      Taro.showToast({ title: '邮箱绑定成功', icon: 'success', duration: 2500 })
      setBindEmailInput('')
      setBindCode('')
      setCodeSent(false)
      setSentTo('')
    } catch (err) {
      Taro.showToast({ title: toFriendlyMessage(err), icon: 'none', duration: 2500 })
    } finally {
      setBindBusy(false)
    }
  }, [bindBusy, bindCode, sentTo])

  const doBindWechat = useCallback(async () => {
    if (wxBusy) return
    setWxBusy(true)
    try {
      await bindWechat()
      Taro.showToast({ title: '微信绑定成功，下次可一键登录', icon: 'success', duration: 2500 })
    } catch (err) {
      Taro.showToast({ title: toFriendlyMessage(err), icon: 'none', duration: 2500 })
    } finally {
      setWxBusy(false)
    }
  }, [wxBusy, bindWechat])

  return (
    <View className='security-page'>
      {/* 当前登录方式 / 邮箱 */}
      <View className='email-card'>
        <Text className='email-label'>
          {hasRealEmail ? '当前登录邮箱' : '当前登录方式'}
        </Text>
        <View className='email-line'>
          <Text className='email-value'>
            {hasRealEmail ? user?.email : '微信一键登录（未绑定邮箱）'}
          </Text>
          {hasRealEmail && (
            <Text className={`email-badge${verified ? ' is-ok' : ''}`}>
              {verified ? '已验证' : '未验证'}
            </Text>
          )}
        </View>
        {isWechatUser && !hasRealEmail && (
          <Text className='email-desc'>
            绑定邮箱后，换设备也能用邮箱找回账号。
          </Text>
        )}
      </View>

      {/* 绑定邮箱（仅未绑邮箱的微信用户） */}
      {isWechatUser && !hasRealEmail && (
        <View className='card'>
          <Text className='card-title'>绑定邮箱</Text>
          <Text className='card-desc'>
            绑定后可用邮箱登录，也是找回账号的唯一途径。
          </Text>

          <View className='row'>
            <Text className='row-label'>邮箱</Text>
            <View className='row-control'>
              <Input
                className='pwd-input'
                placeholder='输入你的邮箱'
                value={codeSent ? sentTo : bindEmailInput}
                disabled={codeSent}
                onInput={(e) => setBindEmailInput(e.detail.value)}
              />
            </View>
          </View>

          {codeSent && (
            <View className='row'>
              <Text className='row-label'>验证码</Text>
              <View className='row-control'>
                <Input
                  className='pwd-input'
                  placeholder='邮件中的 6 位验证码'
                  value={bindCode}
                  onInput={(e) => setBindCode(e.detail.value)}
                />
              </View>
            </View>
          )}

          <View
            className={`submit-btn${
              (codeSent
                ? bindCode.trim().length >= 4
                : EMAIL_RE.test(bindEmailInput.trim())) && !bindBusy
                ? ' is-ready'
                : ''
            }`}
            onClick={codeSent ? doBindEmail : sendBindCode}
          >
            <Text>
              {bindBusy ? '处理中…' : codeSent ? '确认绑定' : '发送验证码'}
            </Text>
          </View>

          {codeSent && (
            <Text className='resend' onClick={sendBindCode}>
              没收到？重新发送
            </Text>
          )}
        </View>
      )}

      {/* 修改密码：邮箱用户走 change-password，微信用户走 set-password */}
      <View className='card'>
        <Text className='card-title'>
          {isWechatUser ? '设置登录密码' : '修改密码'}
        </Text>
        {isWechatUser && (
          <Text className='card-desc'>
            设置后可用「邮箱 + 密码」登录。不影响微信一键登录。
          </Text>
        )}

        {!isWechatUser && (
          <View className='row'>
            <Text className='row-label'>当前密码</Text>
            <View className='row-control'>
              <Input
                className='pwd-input'
                placeholder='输入当前密码'
                password={!showCur}
                value={curPwd}
                onInput={(e) => setCurPwd(e.detail.value)}
              />
              <Text className='eye' onClick={() => setShowCur((v) => !v)}>
                {showCur ? '隐藏' : '显示'}
              </Text>
            </View>
          </View>
        )}

        <View className='row'>
          <Text className='row-label'>{isWechatUser ? '登录密码' : '新密码'}</Text>
          <View className='row-control'>
            <Input
              className='pwd-input'
              placeholder={`至少 ${PASSWORD_MIN_LENGTH} 位`}
              password={!showNew}
              value={newPwd}
              onInput={(e) => setNewPwd(e.detail.value)}
            />
            <Text className='eye' onClick={() => setShowNew((v) => !v)}>
              {showNew ? '隐藏' : '显示'}
            </Text>
          </View>
        </View>

        {newPwd ? (
          <View className={`strength strength-${strength.level}`}>
            <View className='strength-bars'>
              <View className='bar' />
              <View className='bar' />
              <View className='bar' />
            </View>
            <Text className='strength-tip'>{strength.tip}</Text>
          </View>
        ) : null}

        <View className='row'>
          <Text className='row-label'>确认密码</Text>
          <View className='row-control'>
            <Input
              className='pwd-input'
              placeholder='再次输入新密码'
              password={!showNew}
              value={confirmPwd}
              onInput={(e) => setConfirmPwd(e.detail.value)}
            />
          </View>
        </View>

        <View
          className={`submit-btn${
            newPwd.length >= PASSWORD_MIN_LENGTH &&
            newPwd === confirmPwd &&
            (!isWechatUser ? !!curPwd : true) &&
            !pwdBusy
              ? ' is-ready'
              : ''
          }`}
          onClick={submitPassword}
        >
          <Text>{pwdBusy ? '提交中…' : isWechatUser ? '设置密码' : '更新密码'}</Text>
        </View>
      </View>

      {/* 修改邮箱（仅已有真实邮箱的账号） */}
      {hasRealEmail && (
        <View className='card'>
          <Text className='card-title'>修改邮箱</Text>
          <Text className='card-desc'>修改后需到新邮箱完成验证，验证前仍以原邮箱登录。</Text>

          <View className='row'>
            <Text className='row-label'>当前密码</Text>
            <View className='row-control'>
              <Input
                className='pwd-input'
                placeholder='输入当前密码'
                password
                value={curPwd}
                onInput={(e) => setCurPwd(e.detail.value)}
              />
            </View>
          </View>

          <View className='row'>
            <Text className='row-label'>新邮箱</Text>
            <View className='row-control'>
              <Input
                className='pwd-input'
                placeholder='输入新邮箱'
                value={newEmail}
                onInput={(e) => setNewEmail(e.detail.value)}
              />
            </View>
          </View>

          <View
            className={`submit-btn${curPwd && EMAIL_RE.test(newEmail.trim()) && !emailBusy ? ' is-ready' : ''}`}
            onClick={submitEmail}
          >
            <Text>{emailBusy ? '提交中…' : '发送验证邮件'}</Text>
          </View>
        </View>
      )}

      {/* 绑定微信：仅小程序端，且当前账号尚未绑定 */}
      {IS_WEAPP && !wechatBound && (
        <View className='card'>
          <Text className='card-title'>绑定微信</Text>
          <Text className='card-desc'>
            绑定后可用微信一键登录当前账号，不会新建账号，历史数据保留。
          </Text>
          <View
            className={`submit-btn${!wxBusy ? ' is-ready' : ''}`}
            onClick={doBindWechat}
          >
            <Text>{wxBusy ? '绑定中…' : '绑定微信'}</Text>
          </View>
        </View>
      )}

      {/* 已绑定微信的提示 */}
      {IS_WEAPP && wechatBound && (
        <View className='card'>
          <Text className='card-title'>微信</Text>
          <Text className='card-desc'>已绑定，可使用微信一键登录本账号。</Text>
        </View>
      )}
    </View>
  )
}
