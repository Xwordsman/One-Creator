import type { Account, AccountCapabilities, Capability } from '@one-creator/core';
import type { ConnectionRecord } from '../connections.js';
import type { DraftAdapter } from './types.js';
import { wechatAdapter } from './wechat.js';

const adapters: Partial<Record<Account['platform'], DraftAdapter>> = { wechat: wechatAdapter };
export function publicationCapability(
  account: Account,
  connection: Pick<ConnectionRecord, 'status' | 'error' | 'capabilities'> | null,
): Capability {
  if (account.platform !== 'wechat')
    return { status: 'unsupported', reason: '请配置该平台的独立浏览器执行节点' };
  if (!account.active) return { status: 'unsupported', reason: '账号已停用' };
  if (!connection) return { status: 'unsupported', reason: '尚未配置公众号连接' };
  if (['credentials_invalid', 'network_restricted', 'unavailable', 'unchecked'].includes(connection.status))
    return { status: 'unsupported', reason: connection.error || '请先完成连接检查' };
  return (
    connection.capabilities?.publish ?? {
      status: 'unknown',
      reason: '已实现正式发布接口，账号授权尚未验证；可针对选定草稿发起明确的验证提交',
    }
  );
}
export const draftAdapter = (platform: Account['platform']) => adapters[platform] ?? null;
export function draftCapability(
  account: Account,
  connection: Pick<ConnectionRecord, 'status' | 'error'> | null,
): Capability {
  if (!draftAdapter(account.platform))
    return { status: 'unsupported', reason: '该平台的自动草稿通道尚未接入，可导出后手动发布' };
  if (!account.active) return { status: 'unsupported', reason: '账号已停用' };
  if (!connection) return { status: 'unknown', reason: '请先在账号与人设中配置公众号连接' };
  if (connection.status === 'connected')
    return { status: 'supported', reason: '连接检查已通过，可上传正文图片与封面并保存官方草稿' };
  return {
    status: connection.status === 'unchecked' ? 'unknown' : 'unsupported',
    reason: connection.error || '连接尚未验证，请检查 AppID、AppSecret 和 IP 白名单',
  };
}
export function accountCapabilities(
  account: Account,
  connection: ConnectionRecord | null,
): AccountCapabilities {
  return {
    accountId: account.id,
    platform: account.platform,
    connection: connection?.status ?? 'unconfigured',
    capabilities: {
      export: { status: 'supported', reason: '下载正文、图片与发布清单' },
      manual_record: {
        status: account.active ? 'supported' : 'unsupported',
        reason: account.active ? '在平台发布后回填链接和实际时间' : '账号已停用',
      },
      save_draft: draftCapability(account, connection),
      publish: publicationCapability(account, connection),
      schedule:
        account.active && connection?.status === 'connected'
          ? { status: 'supported', reason: '可显式选择定时执行；默认仍为手工计划' }
          : { status: 'unknown', reason: '连接通过后才能启用自动调度' },
      fetch_metrics:
        account.platform === 'wechat' && connection
          ? (connection.capabilities?.metrics ?? {
              status: 'unknown',
              reason: '已实现官方统计接口，需用实际账号验证权限与数据范围',
            })
          : { status: 'unsupported', reason: '此平台尚未提供已验证的数据读取通道，支持手工或 CSV 记录' },
    },
  };
}
