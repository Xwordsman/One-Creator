import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { SessionUser } from '@one-creator/core';
import { api, dateTime, useGet, useCommand, useReferenceOptions } from '../lib/api';
import {
  SchemaFields,
  type SchemaNode,
  schemaDefault,
  type ReferenceOptions,
} from '../components/SchemaForm';
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
  PageHeading,
  Pagination,
  QueryError,
  useToast,
} from '../components/ui';

const rateSchema: SchemaNode = {
  type: 'object',
  properties: {
    baseUrl: { type: 'string', format: 'uri' },
    model: { type: 'string' },
    currency: { type: 'string', enum: ['CNY', 'USD'], default: 'CNY' },
    inputPerMillion: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }], default: null },
    outputPerMillion: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }], default: null },
    unitPrice: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }], default: null },
  },
  required: ['baseUrl', 'model', 'currency'],
};
interface UsageRow {
  id: string;
  title: string;
  model: string;
  capability: string;
  accountId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: string;
  cost: string | null;
  currency: string | null;
  createdAt: string;
  status: string;
}
interface UsageData {
  items: UsageRow[];
  total: number;
  totals: { currency: string | null; knownCost: string | null; unknownCosts: number; estimates: number }[];
}
export default function Usage() {
  const { user } = useOutletContext<{ user: SessionUser }>();
  const [accountId, setAccountId] = useState(''),
    [model, setModel] = useState(''),
    [offset, setOffset] = useState(0),
    [showRates, setShowRates] = useState(false),
    [rate, setRate] = useState(schemaDefault(rateSchema) as Record<string, unknown>);
  const params = new URLSearchParams({
    limit: '20',
    offset: String(offset),
    ...(accountId ? { accountId } : {}),
    ...(model ? { model } : {}),
  });
  const query = useGet<UsageData>(`/usage?${params}`);
  const options = useReferenceOptions<ReferenceOptions>();
  const rates = useGet<{ items: Record<string, unknown>[] }>('/model-prices', user.role === 'admin');
  const toast = useToast();
  const save = useCommand(
    (value: Record<string, unknown>) => api('/model-prices', 'POST', value),
    () => {
      toast('价格已保存，已有用量不会被重新计价');
      setShowRates(false);
    },
  );
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="KNOW YOUR CREATION COST"
        title="模型用量与费用"
        description="报告用量、估算用量和未知成本分别显示，每次重试单独计入。"
      >
        {user.role === 'admin' && (
          <Button onClick={() => setShowRates(true)}>
            <Plus size={16} />
            模型价格
          </Button>
        )}
      </PageHeading>
      <div className="toolbar">
        <select
          aria-label="用量账号"
          value={accountId}
          onChange={(event) => {
            setAccountId(event.target.value);
            setOffset(0);
          }}
        >
          <option value="">全部账号</option>
          {options.data?.accounts?.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          className="compact-input"
          aria-label="按模型 ID 筛选"
          placeholder="模型 ID（精确匹配）"
          value={model}
          onChange={(event) => {
            setModel(event.target.value);
            setOffset(0);
          }}
        />
      </div>
      <div className="summary-grid">
        {query.data?.totals.map((total, index) => (
          <section className="panel summary-card" key={index}>
            <span>{total.currency ?? '未设价格'}</span>
            <strong>{total.knownCost === null ? '未知' : Number(total.knownCost).toFixed(6)}</strong>
            <small>
              {total.unknownCosts} 次成本未知，未计入金额 · {total.estimates} 次用量估算
            </small>
          </section>
        ))}
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} />
      ) : query.data?.items.length ? (
        <div className="panel data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>模型</th>
                <th>输入 / 输出 token</th>
                <th>来源</th>
                <th>费用</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.title}
                    <small>
                      {row.capability} · {row.status}
                    </small>
                  </td>
                  <td>{row.model}</td>
                  <td>
                    {row.inputTokens ?? '未知'} / {row.outputTokens ?? '未知'}
                  </td>
                  <td>
                    <Badge tone={row.usageSource === 'reported' ? 'green' : 'amber'}>
                      {
                        { reported: '供应商 / 结果报告', estimated: '字符粗估', unknown: '未知' }[
                          row.usageSource
                        ]
                      }
                    </Badge>
                  </td>
                  <td>{row.cost === null ? '未知' : `${row.currency} ${Number(row.cost).toFixed(6)}`}</td>
                  <td>{dateTime(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="panel">
          <Empty title="还没有模型用量" description="执行 AI、语义检索或媒体生成后，用量会记录在这里。" />
        </div>
      )}
      {query.data && <Pagination total={query.data.total} offset={offset} limit={20} onChange={setOffset} />}
      <Modal
        open={showRates}
        onClose={() => setShowRates(false)}
        title="模型价格配置"
        description="金额使用所选币种；缺少价格保持未知。单位价可用于每张图片等计量，文本使用每百万 token 价格。"
        wide
      >
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(rate);
          }}
        >
          <SchemaFields schema={rateSchema} value={rate} onChange={setRate} />
          <Alert>{save.error?.message}</Alert>
          <Button type="submit" busy={save.isPending}>
            保存价格
          </Button>
        </form>
        {!!rates.data?.items.length && (
          <div className="result-list">
            {rates.data.items.map((row) => (
              <article key={String(row.id)}>
                <button className="text-link" onClick={() => setRate(row)}>
                  {String(row.model)} · {String(row.currency)} · v{String(row.revision)}
                </button>
                <small>{String(row.baseUrl)}</small>
              </article>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
