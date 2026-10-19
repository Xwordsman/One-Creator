import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Lightbulb,
  Plus,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import type { Dashboard as DashboardData, SessionUser } from '@one-creator/core';
import { documentStatusNames } from '@one-creator/core';
import { dateTime, useGet } from '../lib/api';
import { Badge, Button, Empty, Loading, PlatformBadge, QueryError } from '../components/ui';
import { useState } from 'react';
import { NewDocument } from './Contents';

export default function Dashboard() {
  const { user } = useOutletContext<{ user: SessionUser }>();
  const navigate = useNavigate();
  const query = useGet<DashboardData>('/dashboard');
  const [creating, setCreating] = useState(false);
  if (query.isPending) return <Loading />;
  if (query.error) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  const { counts, documents, tasks } = query.data!;
  const onboarding = [
    {
      title: '建立账号与人设',
      description: '让每个账号拥有自己的表达',
      done: counts.accounts > 0,
      to: '/accounts',
      icon: UsersRound,
    },
    {
      title: '收集第一份素材',
      description: '把值得记录的内容留在这里',
      done: counts.materials > 0,
      to: '/materials',
      icon: BookOpen,
    },
    {
      title: '写下你的第一篇内容',
      description: '从一个想法，走向一篇作品',
      done: counts.documents > 0,
      to: '/contents',
      icon: FileText,
    },
  ];
  return (
    <div className="page-enter">
      <div className="dashboard-welcome">
        <span>你好，{user.name}</span>
        <time>
          {new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(
            new Date(),
          )}
        </time>
      </div>
      <section className="dashboard-hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="tiny-dot" /> YOUR CREATIVE WORKSPACE
          </div>
          <h1>
            把灵感，
            <br className="mobile-only" />
            写成自己的作品。
          </h1>
          <p>管理账号、整理素材，让每一次表达都有迹可循。</p>
          <div className="hero-actions">
            <Button onClick={() => setCreating(true)}>
              <Plus size={18} /> 开始新创作
            </Button>
            <Button variant="ghost" onClick={() => navigate('/ideas')}>
              <Lightbulb size={17} /> 记录灵感
              <ArrowRight size={15} />
            </Button>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-grid" />
          <div className="art-card art-card-back">
            <span className="art-label">素材与灵感</span>
            <div className="art-line" />
            <div className="art-line short" />
            <div className="art-mini-block" />
          </div>
          <div className="art-card art-card-front">
            <span className="art-card-icon">
              <FileText size={21} />
            </span>
            <span className="art-label">每一篇，都有你的风格</span>
            <div className="art-line" />
            <div className="art-line" />
            <div className="art-line short" />
            <div className="art-status">
              <Check size={12} /> 思路正在成形
            </div>
          </div>
          <span className="art-spark">
            <Sparkles size={21} />
          </span>
        </div>
      </section>
      <section className="stats-grid" aria-label="工作空间概览">
        {[
          {
            title: '创作中的内容',
            value: counts.documents,
            note: '母稿与平台版本',
            icon: FileText,
            to: '/contents',
          },
          {
            title: '管理的账号',
            value: counts.accounts,
            note: '每个账号，独立表达',
            icon: UsersRound,
            to: '/accounts',
          },
          {
            title: '积累的素材',
            value: counts.materials,
            note: '让灵感随时可用',
            icon: BookOpen,
            to: '/materials',
          },
          {
            title: '待发布计划',
            value: counts.planned,
            note: `${counts.published} 篇已记录发布`,
            icon: CalendarDays,
            to: '/publishing',
          },
        ].map(({ title, value, note, icon: Icon, to }) => (
          <Link className="stat-card" key={to} to={to}>
            <div className="stat-heading">
              <span>{title}</span>
              <Icon size={19} />
            </div>
            <strong>{value.toString().padStart(2, '0')}</strong>
            <div className="stat-bottom">
              <small>{note}</small>
              <ArrowRight size={15} />
            </div>
          </Link>
        ))}
      </section>
      <div className="dashboard-columns">
        <section className="panel">
          <div className="section-heading">
            <h2>
              <FolderOpen size={18} /> 继续创作
            </h2>
            <Link to="/contents">
              全部内容
              <ChevronRight size={15} />
            </Link>
          </div>
          {documents.length ? (
            <div className="document-rows">
              {documents.map((doc) => (
                <Link to={`/contents/${doc.id}`} className="document-row" key={doc.id}>
                  <span className="document-icon">
                    <FileText size={22} />
                  </span>
                  <div className="document-row-main">
                    <strong>{doc.title}</strong>
                    <div>
                      <PlatformBadge platform={doc.platform} compact />
                      <span>{doc.accountName ?? '通用母稿'}</span>
                      <span>{dateTime(doc.updatedAt)}</span>
                    </div>
                  </div>
                  <Badge tone={doc.status === 'ready' ? 'green' : 'neutral'}>
                    {documentStatusNames[doc.status]}
                  </Badge>
                  <ChevronRight size={17} />
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title="第一篇作品，从这里开始"
              description="创建一份母稿，再把它变成不同账号的表达。"
              icon={FileText}
            >
              <Button variant="secondary" onClick={() => setCreating(true)}>
                <Plus size={16} /> 新建内容
              </Button>
            </Empty>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>
              <CalendarDays size={18} /> 近期发布
            </h2>
            <Link to="/publishing">
              日历
              <ChevronRight size={15} />
            </Link>
          </div>
          {tasks.length ? (
            <div className="upcoming-list">
              {tasks.map((task) => (
                <Link to="/publishing" className="upcoming-item" key={task.id}>
                  <span className="schedule-dot" />
                  <div>
                    <small>{dateTime(task.scheduledAt, task.timezone)}</small>
                    <strong>{task.snapshot.title}</strong>
                    <span>{task.snapshot.context.account?.name}</span>
                  </div>
                  <ArrowRight size={15} />
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title="按照自己的节奏发布"
              description="完成一篇内容后，在这里安排它与读者见面的时间。"
              icon={CalendarDays}
            />
          )}
        </section>
      </div>
      {onboarding.some((step) => !step.done) && (
        <section className="getting-started">
          <div className="section-heading">
            <div>
              <div className="eyebrow">A GOOD START</div>
              <h2>搭好属于你的创作空间</h2>
            </div>
            <span className="muted">{onboarding.filter((step) => step.done).length} / 3 已完成</span>
          </div>
          <div className="onboarding-grid">
            {onboarding.map((step, index) => (
              <Link to={step.to} className={`onboarding-step ${step.done ? 'step-done' : ''}`} key={step.to}>
                <span className="step-number">{step.done ? <Check size={17} /> : `0${index + 1}`}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.description}</p>
                </div>
                <ArrowRight size={17} />
              </Link>
            ))}
          </div>
        </section>
      )}
      <div className="workspace-note">
        <ArrowDownToLine size={16} />
        <span>内容可导出，版本有记录。你的创作，始终属于你。</span>
      </div>
      <NewDocument open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
