/**
 * 账号与安全页。
 *
 * - 展示当前登录邮箱与验证状态
 * - 修改密码：当前密码校验 + 新密码强度提示 + 确认 + 显隐
 * - 修改邮箱：当前密码校验 + 新邮箱（向新邮箱发验证邮件）
 *
 * 两个敏感操作都走独立接口，错误文案已做中文化映射。
 */

import { useCallback, useState } from 'react'
import { View, Text, Input } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useAuth } from '../../../store/auth'
import { changePassword, changeEmail, toFriendlyMessage } from '../../../services/auth'
import { PASSWORD_MIN_LENGTH } from '../../../constants/auth'
import './index.less'

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
  const { user } = useAuth()

  const [curPwd, setCurPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [newEmail, setNewEmail] = useState('')

  const [showCur, setShowCur] = useState(false)
  const [showNew, setShowNew] = useState(false)

  const [pwdBusy, setPwdBusy] = useState(false)
  const [emailBusy, setEmailBusy] = useState(false)

  const strength = passwordStrength(newPwd)

  const submitPassword = useCallback(async () => {
    if (pwdBusy) return
    if (!curPwd) {
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
      const res = await changePassword(curPwd, newPwd)
      Taro.showToast({ title: res.message || '密码已更新', icon: 'success' })
      setCurPwd('')
      setNewPwd('')
      setConfirmPwd('')
    } catch (err) {
      Taro.showToast({ title: toFriendlyMessage(err), icon: 'none', duration: 2500 })
    } finally {
      setPwdBusy(false)
    }
  }, [pwdBusy, curPwd, newPwd, confirmPwd])

  const submitEmail = useCallback(async () => {
    if (emailBusy) return
    if (!curPwd) {
      Taro.showToast({ title: '请先输入当前密码', icon: 'none' })
      return
    }
    const email = newEmail.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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

  const verified = !!user?.emailVerified

  return (
    <View className='security-page'>
      {/* 当前邮箱 */}
      <View className='email-card'>
        <Text className='email-label'>当前登录邮箱</Text>
        <View className='email-line'>
          <Text className='email-value'>{user?.email || '未知'}</Text>
          <Text className={`email-badge${verified ? ' is-ok' : ''}`}>
            {verified ? '已验证' : '未验证'}
          </Text>
        </View>
      </View>

      {/* 修改密码 */}
      <View className='card'>
        <Text className='card-title'>修改密码</Text>

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

        <View className='row'>
          <Text className='row-label'>新密码</Text>
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
          className={`submit-btn${curPwd && newPwd && newPwd === confirmPwd && !pwdBusy ? ' is-ready' : ''}`}
          onClick={submitPassword}
        >
          <Text>{pwdBusy ? '提交中…' : '更新密码'}</Text>
        </View>
      </View>

      {/* 修改邮箱 */}
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
          className={`submit-btn${curPwd && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim()) && !emailBusy ? ' is-ready' : ''}`}
          onClick={submitEmail}
        >
          <Text>{emailBusy ? '提交中…' : '发送验证邮件'}</Text>
        </View>
      </View>
    </View>
  )
}
