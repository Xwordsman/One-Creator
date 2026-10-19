import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  ChevronRight,
  FolderOpen,
  House,
  Lightbulb,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  Search,
  Server,
  Settings2,
  Sparkles,
  Sun,
  UsersRound,
  Library,
  Video,
  BarChart3,
  Wallet,
  Rss,
} from 'lucide-react';
import type { Bootstrap } from '@one-creator/core';
import { api } from '../lib/api';
import { Brand, IconButton, Loading, QueryError } from './ui';
import Auth from '../pages/Auth';
import { NotificationBell } from './NotificationBell';

const navigation = [
  { to: '/', title: '工作台', icon: House, end: true },
  { to: '/contents', title: '内容库', icon: FolderOpen },
  { to: '/ideas', title: '灵感池', icon: Lightbulb },
  { to: '/materials', title: '素材库', icon: LayersIcon },
  { to: '/accounts', title: '账号与人设', icon: UsersRound },
  { to: '/discovery', title: '订阅与资料检索', icon: Rss },
  { to: '/studio', title: '创作资源与运营', icon: Library },
  { to: '/media', title: '媒体与视频', icon: Video },
  { to: '/publishing', title: '发布日历', icon: CalendarDays },
  { to: '/analytics', title: '表现与复盘', icon: BarChart3 },
  { to: '/jobs', title: '任务中心', icon: Sparkles },
  { to: '/usage', title: '模型用量', icon: Wallet },
  { to: '/workspace', title: '成员与集成', icon: UsersRound, admin: true },
  { to: '/settings', title: '设置', icon: Settings2 },
];
function LayersIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
    </svg>
  );
}

export default function Layout() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api<Bootstrap>('/auth/bootstrap'),
    staleTime: 60000,
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('creator-theme') || 'light';
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('creator-theme', theme);
    } catch {
      /* Theme preference is optional. */
    }
  }, [theme]);
  useEffect(() => {
    setMobileOpen(false);
    document.getElementById('main-content')?.focus();
  }, [location.pathname]);
  if (bootstrap.isPending) return <Loading />;
  if (bootstrap.error) return <QueryError error={bootstrap.error} retry={() => void bootstrap.refetch()} />;
  if (!bootstrap.data.user) return <Auth bootstrap={bootstrap.data} />;
  const user = bootstrap.data.user;
  const current = navigation.find((item) =>
    item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to),
  );
  function submitSearch(event: FormEvent) {
    event.preventDefault();
    navigate(`/contents?q=${encodeURIComponent(search)}`);
  }
  async function logout() {
    await api('/auth/logout', 'POST', {});
    client.clear();
    await client.invalidateQueries({ queryKey: ['bootstrap'] });
    navigate('/');
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳转到主要内容
      </a>
      {mobileOpen && (
        <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />
      )}
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <Brand />
          <span className="mobile-only">
            <IconButton label="关闭导航" onClick={() => setMobileOpen(false)}>
              <PanelLeftClose size={19} />
            </IconButton>
          </span>
        </div>
        <div className="workspace-label">
          <span className="workspace-avatar">{user.workspaceName.slice(0, 1)}</span>
          <div>
            <strong>{user.workspaceName}</strong>
            <span>
              {{ admin: '管理员', editor: '编辑成员', viewer: '只读成员' }[user.role]} · 创作工作空间
            </span>
          </div>
        </div>
        <div className="nav-caption">创作空间</div>
        <nav aria-label="主导航">
          {navigation
            .filter((item) => !item.admin || user.role === 'admin')
            .map(({ to, title, icon: Icon, end }) => (
              <div key={to}>
                {to === '/publishing' && <div className="nav-caption nav-caption-second">管理与发布</div>}
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
                >
                  <Icon size={19} />
                  <span>{title}</span>
                </NavLink>
              </div>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <Server size={15} />
            <span>自部署工作台</span>
            <i aria-label="服务已连接" />
          </div>
          <div className="user-panel">
            <span className="user-avatar">{user.name.slice(0, 1)}</span>
            <div>
              <strong>{user.name}</strong>
              <small>让创作成为习惯</small>
            </div>
            <IconButton
              label={theme === 'light' ? '切换深色主题' : '切换浅色主题'}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            >
              {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
            </IconButton>
            <IconButton label="退出登录" onClick={() => void logout().catch(() => bootstrap.refetch())}>
              <LogOut size={16} />
            </IconButton>
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <div className="topbar-location">
            <span className="mobile-only">
              <IconButton label="打开导航" onClick={() => setMobileOpen(true)}>
                <Menu size={21} />
              </IconButton>
            </span>
            <span className="breadcrumb-root">工作空间</span>
            <ChevronRight size={13} />
            <span>{current?.title ?? '内容编辑'}</span>
          </div>
          <form className="global-search" onSubmit={submitSearch}>
            <Search size={16} />
            <input
              aria-label="搜索内容"
              placeholder="搜索你的内容…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd>↵</kbd>
          </form>
          <span className="alpha-badge">ALPHA 0.1</span>
          <NotificationBell />
        </header>
        <main id="main-content" tabIndex={-1} className="main-content">
          <Outlet context={{ user }} />
        </main>
        <footer className="app-footer">
          <span>One-Creator</span>
          <span>给创作一点秩序，给灵感更多空间。</span>
        </footer>
      </div>
    </div>
  );
}
