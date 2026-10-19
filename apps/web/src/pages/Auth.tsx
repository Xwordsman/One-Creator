import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Eye, EyeOff, Layers3, LockKeyhole, PenLine } from 'lucide-react';
import type { Bootstrap } from '@one-creator/core';
import { api, text } from '../lib/api';
import { Alert, Brand, Button, Field, IconButton } from '../components/ui';

export default function Auth({ bootstrap }: { bootstrap: Bootstrap }) {
  const setup = bootstrap.needsSetup;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api(setup ? '/auth/setup' : '/auth/login', 'POST', {
        username: text(data, 'username'),
        password: String(data.get('password') ?? ''),
        ...(setup ? { name: text(data, 'name'), workspaceName: text(data, 'workspaceName') } : {}),
      });
      await client.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand large />
        <div className="auth-copy">
          <div className="eyebrow">YOUR OWN CREATIVE SPACE</div>
          <h1>
            好内容，
            <br />
            从有序的
            <br />
            <em>创作开始。</em>
          </h1>
          <p>
            把不同账号的灵感、素材和表达，
            <br />
            留在一个真正属于你的工作台。
          </p>
          <div className="auth-promises">
            <span>
              <Check size={16} /> 多账号，独立风格
            </span>
            <span>
              <Check size={16} /> 自部署，内容归自己
            </span>
          </div>
        </div>
        <div className="auth-illustration" aria-hidden="true">
          <div className="paper paper-back">
            <Layers3 size={30} />
          </div>
          <div className="paper paper-front">
            <PenLine size={24} />
            <div className="paper-line long" />
            <div className="paper-line" />
            <div className="paper-line medium" />
            <span>每一个想法，都值得认真对待。</span>
          </div>
        </div>
        <span className="auth-footer">ONE-CREATOR / OPEN SOURCE CREATOR WORKSPACE</span>
      </section>
      <section className="auth-form-side">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-form-card">
          <span className="small-icon">
            <LockKeyhole size={21} />
          </span>
          <h2>{setup ? '开启你的创作空间' : '欢迎回到创作空间'}</h2>
          <p>{setup ? '第一次使用，创建一个工作台账号。' : '登录后，继续上一次的灵感。'}</p>
          <form onSubmit={submit} className="form-stack">
            {setup && (
              <div className="form-grid">
                <Field label="怎么称呼你" required>
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={80}
                    placeholder="你的名字"
                    autoFocus
                  />
                </Field>
                <Field label="工作空间名称" required>
                  <input name="workspaceName" defaultValue="我的创作空间" required maxLength={80} />
                </Field>
              </div>
            )}
            <Field label="登录账号" required hint="3–40 位字母、数字、下划线或短横线">
              <input
                name="username"
                autoComplete="username"
                required
                minLength={3}
                maxLength={40}
                pattern="[a-zA-Z0-9_.\-]+"
                placeholder="例如 creator"
                autoFocus={!setup}
              />
            </Field>
            <Field label="密码" required hint={setup ? '至少 10 位。用于登录此工作台。' : undefined}>
              <span className="password-input">
                <input
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={setup ? 'new-password' : 'current-password'}
                  required
                  minLength={10}
                  maxLength={200}
                  placeholder="输入密码"
                />
                <IconButton
                  label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </IconButton>
              </span>
            </Field>
            <Alert>{error}</Alert>
            <Button type="submit" busy={busy} className="button-full">
              {setup ? '创建工作空间' : '进入工作台'}
              <ArrowRight size={17} />
            </Button>
          </form>
          <p className="auth-note">独立部署 · 你的内容与配置保存在此实例</p>
        </div>
        <div className="auth-version">
          One-Creator <span>{bootstrap.version}</span>
        </div>
      </section>
    </main>
  );
}
