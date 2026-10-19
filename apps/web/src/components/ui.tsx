import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Loader2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { platforms, type Platform } from '@one-creator/core';

export function Button({
  variant = 'primary',
  busy,
  children,
  className = '',
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      className={`button button-${variant} ${className}`}
      aria-busy={busy || undefined}
    >
      {busy && <Loader2 size={16} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      {...props}
      className={`icon-button ${props.className ?? ''}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  hint,
  children,
  required,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  const id = useId();
  function labelControl(nodes: ReactNode): ReactNode {
    return Children.map(nodes, (node) => {
      if (!isValidElement<Record<string, unknown>>(node)) return node;
      if (['input', 'select', 'textarea'].includes(String(node.type)))
        return cloneElement(node, { id, 'aria-describedby': hint ? `${id}-hint` : undefined });
      return node.props.children
        ? cloneElement(node, { children: labelControl(node.props.children as ReactNode) })
        : node;
    });
  }
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {labelControl(children)}
      {hint && (
        <span id={`${id}-hint`} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
export function Alert({ children }: { children?: ReactNode }) {
  return children ? (
    <div className="alert" role="alert">
      <AlertCircle size={17} aria-hidden="true" />
      <div>{children}</div>
    </div>
  ) : null;
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const descriptionId = useId();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog-content ${wide ? 'dialog-wide' : ''}`}
          aria-describedby={description ? descriptionId : undefined}
        >
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && <Dialog.Description id={descriptionId}>{description}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <IconButton label="关闭对话框">
                <X size={20} />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
export function Empty({
  title,
  description,
  icon: Icon = Inbox,
  children,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={29} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Loading({ label = '正在加载工作空间…' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <Loader2 className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}
export function QueryError({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="query-error">
      <Alert>{error.message}</Alert>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          重新加载
        </Button>
      )}
    </div>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function PlatformBadge({ platform, compact = false }: { platform?: Platform; compact?: boolean }) {
  if (!platform) return <Badge>母稿</Badge>;
  return (
    <span className={`platform-badge platform-${platform}`}>
      <i aria-hidden="true" />
      {compact ? platforms[platform].short : platforms[platform].name}
    </span>
  );
}
export function Pagination({
  total,
  offset,
  limit,
  onChange,
}: {
  total: number;
  offset: number;
  limit: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit) return null;
  return (
    <div className="pagination">
      <span>
        第 {offset + 1}–{Math.min(offset + limit, total)} 项，共 {total} 项
      </span>
      <div>
        <IconButton label="上一页" disabled={!offset} onClick={() => onChange(Math.max(0, offset - limit))}>
          <ChevronLeft size={18} />
        </IconButton>
        <IconButton
          label="下一页"
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          <ChevronRight size={18} />
        </IconButton>
      </div>
    </div>
  );
}

const ToastContext = createContext<(message: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 4000);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <ToastContext.Provider value={setMessage}>
      {children}
      <div className="toast-region" aria-live="polite">
        {message && (
          <div className="toast">
            <CheckCircle2 size={18} />
            <span>{message}</span>
            <IconButton label="关闭通知" onClick={() => setMessage('')}>
              <X size={16} />
            </IconButton>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
export function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className={`brand ${large ? 'brand-large' : ''}`}>
      <span className="brand-mark" aria-hidden="true">
        <svg width="25" height="25" viewBox="0 0 32 32" fill="none">
          <path d="M21 6a10 10 0 1 0 5 14" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M18 13a6 6 0 1 0 5 9" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
        </svg>
      </span>
      <span>
        One<span className="brand-divider">–</span>Creator
      </span>
    </div>
  );
}
