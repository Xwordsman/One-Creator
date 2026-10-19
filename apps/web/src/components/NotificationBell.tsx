import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api } from '../lib/api';

export interface Notice {
  id: string;
  title: string;
  body: string;
  path: string;
  createdAt: string;
  readAt: string | null;
}
export interface Notices {
  items: Notice[];
  total: number;
  unread: number;
}
export function NotificationBell() {
  const query = useQuery({
    queryKey: ['get', '/notifications?limit=1'],
    queryFn: () => api<Notices>('/notifications?limit=1'),
    refetchInterval: 15000,
  });
  const unread = query.data?.unread ?? 0;
  return (
    <Link
      className="icon-button notification-bell"
      aria-label={`站内通知，${unread} 条未读`}
      to="/notifications"
    >
      <Bell size={18} />
      {!!unread && <span>{unread > 99 ? '99+' : unread}</span>}
    </Link>
  );
}
