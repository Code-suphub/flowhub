import { useEffect, useState } from 'react';
import { host, type SearchItem } from './types';

export function mailReceivedAt(item: SearchItem): Date | undefined {
  if (item.type !== 'twofa' || item.source !== 'mail' || typeof item.receivedAt !== 'number') return;
  const date = new Date(item.receivedAt);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

type Display = { code: string; remaining: number } | { message: string };
type Code = { code: string; expiresAt: number };
const loading = { message: '正在读取验证码…' };

type MailHistoryEntry = { id: string; code: string; sender: string; receivedAt: number; historyUntil: number };

export function MailCodeHistory({ item }: { item: SearchItem }) {
  const { id, mailCodeId, mailHistoryKey } = item;
  const [history, setHistory] = useState<MailHistoryEntry[]>([]);

  useEffect(() => {
    const readHistory = host.weborg?.previewMailCodeHistory;
    if (!mailHistoryKey || !readHistory || document.documentElement.dataset.weborgReadonly === 'true') {
      setHistory([]);
      return;
    }
    let revision = 0;
    function hide() {
      revision++;
      setHistory([]);
    }
    function refresh() {
      if (document.hidden || !document.hasFocus()) return;
      const request = ++revision;
      void readHistory(id, mailCodeId).then((rows: MailHistoryEntry[]) => {
        if (revision !== request) return;
        setHistory(Array.isArray(rows) ? rows.filter(row =>
          typeof row?.id === 'string' && typeof row.code === 'string' && /^\d{4,8}$/.test(row.code)
          && typeof row.sender === 'string' && Number.isFinite(new Date(row.receivedAt).getTime())
          && row.historyUntil > Date.now()
        ).slice(0, 5) : []);
      }, () => {
        if (revision === request) setHistory([]);
      });
    }
    function visibilityChanged() {
      if (document.hidden) hide();
      else refresh();
    }
    refresh();
    window.addEventListener('blur', hide);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      revision++;
      window.removeEventListener('blur', hide);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [id, mailCodeId, mailHistoryKey]);

  const entries = history.filter(row => row.id !== mailCodeId && row.historyUntil > Date.now());
  if (!entries.length) return null;
  return <section className="mail-code-history mt-4 border-t pt-3" aria-label="近期邮件验证码">
    <h3 className="verification-time mb-1 text-xs font-medium">近期历史</h3>
    <ul className="m-0 list-none p-0">
      {entries.map(row => {
        const receivedAt = new Date(row.receivedAt);
        return <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1">
          <span className="select-none font-mono text-sm tabular-nums">{row.code}</span>
          <span className="verification-time break-all text-xs">{row.sender}</span>
          <time className="verification-time text-xs" dateTime={receivedAt.toISOString()}>{receivedAt.toLocaleString()}</time>
        </li>;
      })}
    </ul>
  </section>;
}

export function VerificationPreview({ item }: { item: SearchItem }) {
  const { title, source, expiresAt, mailAccount } = item;
  const id = mailAccount ? item.mailCodeId : item.id;
  const waiting = mailAccount && !id;
  const expiredMessage = mailAccount ? item.credentialsMissing?'请填写邮箱授权码':'等待验证码' : '验证码已过期';
  const [display, setDisplay] = useState<Display>(loading);

  useEffect(() => {
    if (waiting) return;
    const preview = host.weborg?.previewVerificationCode;
    if (!preview || document.documentElement.dataset.weborgReadonly === 'true') {
      setDisplay({ message: '请在 FlowHub 中查看验证码' });
      return;
    }
    let revision = 0;
    let timer: number | undefined;

    function clear() {
      revision++;
      window.clearTimeout(timer);
    }

    function refresh() {
      clear();
      if (document.hidden || !document.hasFocus()) return;
      if (source === 'mail' && typeof expiresAt === 'number' && expiresAt <= Date.now()) {
        setDisplay({ message: expiredMessage });
        return;
      }
      const request = revision;
      setDisplay(loading);
      void preview({ id, title, source }).then((value: Code) => {
        if (revision !== request) return;
        if (typeof value?.code !== 'string' || !/^\d{4,8}$/.test(value.code) || !Number.isFinite(value.expiresAt)) {
          setDisplay({ message: '验证码不可用' });
          return;
        }
        function tick() {
          const milliseconds = value.expiresAt - Date.now();
          if (milliseconds <= 0) {
            setDisplay({ message: source === 'mail' ? expiredMessage : '正在更新验证码…' });
            if (source !== 'mail') timer = window.setTimeout(refresh, 200);
            return;
          }
          setDisplay({ code: value.code, remaining: Math.ceil(milliseconds / 1000) });
          timer = window.setTimeout(tick, milliseconds % 1000 || 1000);
        }
        tick();
      }, () => {
        if (revision === request) setDisplay({ message: '验证码不可用或已过期' });
      });
    }

    function conceal() {
      clear();
      setDisplay(loading);
    }
    function visibilityChanged() {
      if (document.hidden) conceal();
      else refresh();
    }
    refresh();
    window.addEventListener('blur', conceal);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      clear();
      window.removeEventListener('blur', conceal);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [id, title, source, expiresAt, waiting, expiredMessage]);

  return <div className="verification-preview mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
    {waiting ? <span className="verification-time text-xs" role="status">{expiredMessage}</span> : 'code' in display ? <>
      <span className="verification-digits select-none font-mono text-3xl font-semibold tabular-nums" aria-label={'验证码 ' + display.code}>{display.code}</span>
      <span className="verification-time text-xs tabular-nums">剩余 {display.remaining} 秒</span>
    </> : <span className="verification-time text-xs" role="status">{display.message}</span>}
  </div>;
}
