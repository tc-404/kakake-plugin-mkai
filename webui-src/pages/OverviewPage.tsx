import { useRef } from 'react';
import type { MkaiApiClient } from '../api';
import { DonutChart, Gauge, MiniBar, type BarDatum } from '../components/charts';
import { useOverviewController } from '../controllers/useOverviewController';
import { useDeviceKind } from '../hooks/useDeviceKind';
import { useUsageDonutSize } from '../hooks/useUsageDonutSize';

/** 紧凑数字：12345→1.2w，1200→1.2k */
function fmtNum(n: number): string {
  const v = Math.abs(n);
  if (v >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (v >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + 'w';
  if (v >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

/** Token 专用紧凑数字：超过 100 万（1,000,000）转成 M（1M / 1.5M），其余沿用 w / k */
function fmtTokens(n: number): string {
  const v = Math.abs(n);
  if (v >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (v >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + 'w';
  if (v >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

/** 预计花费：小额保留 4 位并去尾零 */
function fmtCost(n: number): string {
  if (!n) return '0';
  if (n < 1) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return n.toFixed(2);
}

function Kpi({ num, label, sm }: { num: string; label: string; sm?: boolean }) {
  return (
    <div className="ov-kpi__cell">
      <span className={`ov-kpi__num${sm ? ' ov-kpi__num--sm' : ''}`}>{num}</span>
      <span className="ov-kpi__label">{label}</span>
    </div>
  );
}

export function OverviewPage({ api }: { api: MkaiApiClient }) {
  const { loading, stats: s } = useOverviewController(api);
  const kind = useDeviceKind();
  const usageGridRef = useRef<HTMLDivElement>(null);
  const donut = useUsageDonutSize(usageGridRef, kind);

  if (loading) {
    return (
      <section className="mkai-page-overview">
        <div className="ov-grid">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card ov-card ov-skeleton" style={{ animationDelay: `${i * 0.05}s` }} />
          ))}
        </div>
      </section>
    );
  }

  const enabledTotal = s.groupEnabled + s.friendEnabled;
  const coverage: BarDatum[] = [
    { label: '群聊', value: s.groupEnabled, hint: `已开启 ${s.groupEnabled} / 共 ${s.groupTotal}` },
    { label: '好友', value: s.friendEnabled, hint: `已开启 ${s.friendEnabled} / 共 ${s.friendTotal}` },
  ];
  const caps: BarDatum[] = [
    { label: '识图', value: s.capImage, color: 'var(--mk-brand-400)' },
    { label: '联网', value: s.capWeb, color: 'var(--mk-info)' },
    { label: '表情', value: s.capSticker, color: 'var(--mk-brand-600)' },
  ];

  return (
    <section className="mkai-page-overview">
      <div className="ov-grid">
        <article className="glass-card ov-card ov-card--full">
          <div className="mk-panel-head"><h3 className="ov-card__title">接入信息</h3></div>
          <div className="mk-panel-body">
            <dl className="ov-meta">
              <div><dt>厂商</dt><dd>{s.vendorName}</dd></div>
              <div><dt>模型</dt><dd title={s.modelLabel}>{s.modelLabel}</dd></div>
              <div><dt>人格昵称</dt><dd>{s.botNickname || '—'}</dd></div>
              <div><dt>自定义厂商</dt><dd>{s.customVendorCount}</dd></div>
              <div><dt>工具技能</dt><dd>{s.toolEnabled}/{s.toolTotal}</dd></div>
              <div><dt>表情图库</dt><dd>{s.stickerReady ? '已就绪' : '未安装'}</dd></div>
            </dl>
          </div>
        </article>

        <article className="glass-card ov-card ov-card--full ov-card--usage">
          <div className="mk-panel-head"><h3 className="ov-card__title">Token 与会话</h3></div>
          <div className="mk-panel-body ov-usage-grid" ref={usageGridRef}>
            <section className="ov-usage-col">
              <div className="ov-usage-col__label">Token 构成</div>
              <div className="ov-usage-donut">
                <DonutChart
                  size={donut.size}
                  thickness={donut.thickness}
                  interactive
                  formatValue={fmtTokens}
                  ariaLabel="Token 构成环形图，点击色块查看占比"
                  segments={[
                    { value: s.promptTokens, color: 'var(--mk-brand-400)', label: '提示' },
                    { value: s.completionTokens, color: 'var(--mk-brand-700)', label: '补全' },
                  ]}
                  centerNum={fmtTokens(s.totalTokens)}
                />
              </div>
            </section>
            <section className="ov-usage-col">
              <div className="ov-usage-col__label">会话概况</div>
              <div className="ov-usage-donut">
                <DonutChart
                  size={donut.size}
                  thickness={donut.thickness}
                  interactive
                  formatValue={fmtNum}
                  ariaLabel="会话概况环形图，点击色块查看占比"
                  segments={[
                    { value: s.sessionsActive, color: 'var(--mk-brand-700)', label: '活跃' },
                    { value: s.sessionsGroup, color: 'var(--mk-brand-500)', label: '群聊' },
                    { value: s.sessionsPrivate, color: 'var(--mk-brand-300)', label: '私聊' },
                    { value: s.totalMessages, color: 'var(--mk-info)', label: '消息' },
                  ]}
                  centerNum={String(s.sessionsTotal)}
                />
              </div>
            </section>
          </div>
        </article>

        <article className="glass-card ov-card">
          <div className="mk-panel-head">
            <h3 className="ov-card__title">{s.balanceIsRate ? '限速用量' : '账户余额'}</h3>
          </div>
          <div className="mk-panel-body ov-card__chart">
            {s.balancePct != null ? (
              <Gauge
                value={s.balancePct}
                tone={s.balanceTone === 'ok' ? 'var(--mk-brand-600)' : 'var(--mk-warn)'}
                centerNum={s.balanceLabel}
                centerSub={s.balanceAvailable ? '可用' : ''}
              />
            ) : (
              <div className={`ov-bignum ov-bignum--${s.balanceTone}`}>{s.balanceLabel}</div>
            )}
          </div>
        </article>

        <article className="glass-card ov-card">
          <div className="mk-panel-head"><h3 className="ov-card__title">缓存命中</h3></div>
          <div className="mk-panel-body ov-card__chart">
            {s.cacheHitRate != null ? (
              <Gauge value={s.cacheHitRate} tone="var(--mk-info)" centerNum={`${Math.round(s.cacheHitRate)}%`} centerSub="命中率" />
            ) : (
              <div className="ov-bignum ov-bignum--muted">—</div>
            )}
          </div>
        </article>

        <article className="glass-card ov-card ov-card--span2">
          <div className="mk-panel-head"><h3 className="ov-card__title">开启覆盖（{enabledTotal}）</h3></div>
          <div className="mk-panel-body">
            <MiniBar data={coverage} barColor="var(--mk-brand-600)" format={(v) => String(v)} />
            <div className="ov-caps">
              <MiniBar data={caps} format={(v) => String(v)} />
            </div>
          </div>
        </article>

        <article className="glass-card ov-card ov-card--full">
          <div className="mk-panel-head"><h3 className="ov-card__title">消息量 Top 5</h3></div>
          <div className="mk-panel-body">
            {s.topSessions.length ? (
              <MiniBar data={s.topSessions} format={fmtNum} />
            ) : (
              <div className="mk-state">暂无会话</div>
            )}
          </div>
        </article>

        <article className="glass-card ov-card ov-card--full ov-card--kpi-row">
          <div className="mk-panel-body">
            <div className="ov-kpi ov-kpi--footer">
              <Kpi num={fmtNum(s.totalRequests)} label="累计请求" />
              <Kpi num={fmtTokens(s.totalTokens)} label="累计 Token" />
              <Kpi num={fmtNum(s.todayRequests)} label="今日请求" />
              <Kpi num={fmtCost(s.estimatedCost)} label="预计花费" />
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}