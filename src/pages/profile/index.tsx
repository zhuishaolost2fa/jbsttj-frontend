/**
 * 个人中心。
 *
 * 账号相关的操作原先挤在首页顶部的一条窄条里，改成 tabBar 后归拢到这里，
 * 首页专心做「导入」这一件事。资料编辑与账号安全从这里进入。
 */

import { useCallback } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { goLogin, useAuth } from '../../store/auth'
import Avatar from '../../components/Avatar'
import './index.less'

const GENDER_LABEL: Record<string, string> = {
  male: '男',
  female: '女',
  other: '保密',
}

function ProfilePage() {
  const { status, user, isAuthenticated, logout } = useAuth()

  const handleLogout = useCallback(() => {
    void Taro.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmText: '退出',
      confirmColor: '#e54d42',
    }).then((res) => {
      if (res.confirm) {
        logout()
        Taro.showToast({ title: '已退出登录', icon: 'none' })
      }
    })
  }, [logout])

  const displayName = user?.nickname || user?.email || '未登录'
  const genderText = user?.gender ? GENDER_LABEL[user.gender] : ''
  const subLine = [user?.region, genderText].filter(Boolean).join(' · ') || '剧本与解析记录都挂在此账号下'

  return (
    <View className='profile-page'>
      {/* ===== 账号卡片 ===== */}
      <View className='account-card'>
        {status === 'loading' ? (
          <Text className='account-loading'>正在恢复登录状态…</Text>
        ) : isAuthenticated ? (
          <View className='account-inner'>
            <Avatar
              name={user?.nickname || user?.email}
              url={user?.avatarUrl}
              color={user?.avatarColor}
              size={56}
            />
            <View className='account-body'>
              <Text className='account-email'>{displayName}</Text>
              <Text className='account-sub'>{subLine}</Text>
            </View>
            <View
              className='account-edit'
              onClick={() => Taro.navigateTo({ url: '/pages/profile/edit/index' })}
            >
              <Text className='account-edit-text'>编辑</Text>
            </View>
          </View>
        ) : (
          <View className='account-inner'>
            <Avatar name='guest' color={0} size={56} />
            <View className='account-body'>
              <Text className='account-email'>未登录</Text>
              <Text className='account-sub'>登录后可导入剧本、使用 AI 问答</Text>
            </View>
            <View className='login-btn' onClick={() => goLogin()}>
              <Text className='login-btn-text'>登录</Text>
            </View>
          </View>
        )}
      </View>

      {/* ===== 资料 / 安全 ===== */}
      {isAuthenticated ? (
        <View className='menu-group'>
          <View
            className='menu-item'
            onClick={() => Taro.navigateTo({ url: '/pages/profile/edit/index' })}
          >
            <Text className='menu-icon'>📝</Text>
            <Text className='menu-label'>编辑资料</Text>
            <Text className='menu-arrow'>&#x203A;</Text>
          </View>
          <View
            className='menu-item'
            onClick={() => Taro.navigateTo({ url: '/pages/profile/security/index' })}
          >
            <Text className='menu-icon'>🔐</Text>
            <Text className='menu-label'>账号与安全</Text>
            <Text className='menu-arrow'>&#x203A;</Text>
          </View>
        </View>
      ) : null}

      {/* ===== 功能入口 ===== */}
      <View className='menu-group'>
        <View
          className='menu-item'
          onClick={() => Taro.switchTab({ url: '/pages/scripts/index' })}
        >
          <Text className='menu-icon'>📚</Text>
          <Text className='menu-label'>我的剧本</Text>
          <Text className='menu-arrow'>&#x203A;</Text>
        </View>
        <View
          className='menu-item'
          onClick={() => Taro.switchTab({ url: '/pages/index/index' })}
        >
          <Text className='menu-icon'>📥</Text>
          <Text className='menu-label'>导入 DM 手册</Text>
          <Text className='menu-arrow'>&#x203A;</Text>
        </View>
      </View>

      <View className='menu-group'>
        <View
          className='menu-item'
          onClick={() =>
            Taro.showModal({
              title: '关于',
              content:
                '剧本杀复盘助手：导入 DM 主持人手册后自动建立语义索引，带本时可即时检索规则与流程。',
              showCancel: false,
            })
          }
        >
          <Text className='menu-icon'>ℹ️</Text>
          <Text className='menu-label'>关于</Text>
          <Text className='menu-arrow'>&#x203A;</Text>
        </View>
      </View>

      {isAuthenticated ? (
        <View className='logout-btn' onClick={handleLogout}>
          <Text className='logout-text'>退出登录</Text>
        </View>
      ) : null}

      <Text className='foot-hint'>⚠️ 复盘含剧透，未玩过的本请勿查看</Text>
    </View>
  )
}

export default ProfilePage
