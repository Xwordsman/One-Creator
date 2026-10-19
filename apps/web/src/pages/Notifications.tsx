import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { api, dateTime, useCommand } from '../lib/api';
import { Alert, Button, Empty, Loading, PageHeading, Pagination, QueryError } from '../components/ui';
import type { Notices } from '../components/NotificationBell';
export default function Notifications() {
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ['get', `/notifications?limit=30&offset=${offset}`],
    queryFn: () => api<Notices>(`/notifications?limit=30&offset=${offset}`),
    refetchInterval: 15000,
  });
  const read = useCommand((ids: string[]) => api('/notifications/read', 'POST', { ids }));
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="NOTHING IMPORTANT GETS LOST"
        title="站内通知"
        description="失败任务、账号连接和待处理发布，集中留在这里。"
      >
        <Button
          variant="secondary"
          disabled={!query.data?.items.some((item) => !item.readAt)}
          busy={read.isPending}
          onClick={() => read.mutate(query.data!.items.filter((item) => !item.readAt).map((item) => item.id))}
        >
          <CheckCheck size={16} />
          本页标为已读
        </Button>
      </PageHeading>
      <Alert>{read.error?.message}</Alert>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} />
      ) : query.data.items.length ? (
        <div className="panel notices-list">
          {query.data.items.map((notice) => (
            <article key={notice.id} className={`notice-row ${notice.readAt ? '' : 'unread'}`}>
              <Bell size={18} />
              <div>
                <Link
                  to={notice.path}
                  onClick={() => {
                    if (!notice.readAt) read.mutate([notice.id]);
                  }}
                >
                  {notice.title}
                </Link>
                <p>{notice.body}</p>
                <small>{dateTime(notice.createdAt)}</small>
              </div>
              {!notice.readAt && (
                <Button variant="ghost" onClick={() => read.mutate([notice.id])}>
                  已读
                </Button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            icon={Bell}
            title="暂时没有通知"
            description="重要变化会记录为通知，相同事件不会反复生成。"
          />
        </div>
      )}
      {query.data && <Pagination total={query.data.total} offset={offset} limit={30} onChange={setOffset} />}
    </div>
  );
}
