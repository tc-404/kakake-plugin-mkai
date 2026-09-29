import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MkaiApiClient } from '../api';
import type { ToastFn } from '../notify';

type VoiceCfg = {
  engine?: string;
  api_key?: string;
  api_key_set?: boolean;
  dub?: string;
  format?: string;
  qq_character?: string;
  qq_ref_group?: string;
  max_chars?: number;
};

type QQChar = { id: string; name: string; group: string };

/**
 * 第三方配音（pearapi）官网注册/登录地址。
 * 带 ref 邀请参数：用户从这里注册后能拿到自己的密钥，填进「配音密钥」框即可用自己的额度。
 */
const PEARAPI_HOME = 'https://api.pearapi.ai/zh/auth?ref=V9SSQ7AT';

/**
 * 第三方配音的默认角色 —— 必须与宿主 `smart-chat-config.ts` 的 DEFAULT_VOICE_DUB 一致。
 *
 * 这里只用于**展示**（占位提示、一键填入按钮），真正的兜底在宿主归一化里做：
 * 前端把空串原样存进去，宿主读回来时会补成这个默认值。这样「前端不填」与
 * 「用户手动清空」语义一致，都回到默认角色。
 */
const DEFAULT_VOICE_DUB = '病娇少女';

/** 语音输出配置页：引擎二选一 + 各自的角色/密钥/格式 + 单条限长 */
export function VoicePage({ api, toast }: { api: MkaiApiClient; toast: ToastFn }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [engine, setEngine] = useState<'pearapi' | 'qqai'>('pearapi');

  // pearapi
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyDirty, setKeyDirty] = useState(false);
  const [dub, setDub] = useState('');
  const [format, setFormat] = useState<'ogg' | 'mp3'>('ogg');
  const [roles, setRoles] = useState<string[]>([]);
  const [roleListOpen, setRoleListOpen] = useState(false);
  const [fetchingRoles, setFetchingRoles] = useState(false);
  const [roleSearch, setRoleSearch] = useState('');

  // qqai
  const [qqCharacter, setQqCharacter] = useState('');
  const [qqRefGroup, setQqRefGroup] = useState('');
  const [qqChars, setQqChars] = useState<QQChar[]>([]);
  const [qqListOpen, setQqListOpen] = useState(false);
  const [fetchingQq, setFetchingQq] = useState(false);
  const [qqSearch, setQqSearch] = useState('');

  const [maxChars, setMaxChars] = useState(150);

  const pickerRef = useRef<HTMLDivElement | null>(null);
  const qqPickerRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ voice?: VoiceCfg }>('/smart-chat/config');
      if (r.code !== 0) throw new Error(r.message || '加载失败');
      const v = (r.data && r.data.voice) || {};
      setEngine(v.engine === 'qqai' ? 'qqai' : 'pearapi');
      setApiKeySet(!!v.api_key_set);
      setApiKeyMasked(String(v.api_key || ''));
      setApiKey('');
      setKeyDirty(false);
      setDub(String(v.dub || ''));
      setFormat(v.format === 'mp3' ? 'mp3' : 'ogg');
      setQqCharacter(String(v.qq_character || ''));
      setQqRefGroup(String(v.qq_ref_group || ''));
      setMaxChars(Number(v.max_chars) || 150);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setLoading(false);
    }
  }, [api, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!roleListOpen && !qqListOpen) return;
    const onDoc = (ev: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(ev.target as Node)) setRoleListOpen(false);
      if (qqPickerRef.current && !qqPickerRef.current.contains(ev.target as Node)) setQqListOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [roleListOpen, qqListOpen]);

  const fetchRoles = useCallback(async () => {
    setFetchingRoles(true);
    try {
      const r = await api.get<{ ok?: boolean; roles?: string[]; error?: string }>('/smart-chat/voice-roles');
      const d = r.data || {};
      if (r.code !== 0) throw new Error(r.message || '拉取失败');
      const list = Array.isArray(d.roles) ? d.roles : [];
      setRoles(list);
      setRoleListOpen(true);
      if (!list.length) toast(d.error || '未获取到角色，可手动填写角色名', 'err');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setFetchingRoles(false);
    }
  }, [api, toast]);

  const fetchQqChars = useCallback(async () => {
    const gid = qqRefGroup.trim();
    if (!gid) {
      toast('先填一个参考群号（用于拉取 QQ AI 角色）', 'err');
      return;
    }
    setFetchingQq(true);
    try {
      const r = await api.get<{ ok?: boolean; characters?: QQChar[]; error?: string }>(
        `/smart-chat/voice-characters?group_id=${encodeURIComponent(gid)}`,
      );
      const d = r.data || {};
      if (r.code !== 0) throw new Error(r.message || '拉取失败');
      const list = Array.isArray(d.characters) ? d.characters : [];
      setQqChars(list);
      setQqListOpen(true);
      if (!list.length) toast(d.error || '未获取到 QQ AI 角色（该群可能未开通或机器人不在群）', 'err');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setFetchingQq(false);
    }
  }, [api, toast, qqRefGroup]);

  const filteredRoles = useMemo(() => {
    const q = roleSearch.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((n) => n.toLowerCase().includes(q));
  }, [roles, roleSearch]);

  const filteredQq = useMemo(() => {
    const q = qqSearch.trim().toLowerCase();
    if (!q) return qqChars;
    return qqChars.filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [qqChars, qqSearch]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        engine,
        dub: dub.trim(),
        format,
        qq_character: qqCharacter.trim(),
        qq_ref_group: qqRefGroup.trim(),
        max_chars: maxChars,
      };
      // 仅在用户改动过密钥时才提交：空串=改回内置额度，非空=设为自有密钥
      if (keyDirty) payload.api_key = apiKey.trim();
      const r = await api.post<{ ok?: boolean; voice?: VoiceCfg }>('/smart-chat/voice-config', payload);
      if (r.code !== 0) throw new Error(r.message || '保存失败');
      const v = (r.data && r.data.voice) || {};
      setEngine(v.engine === 'qqai' ? 'qqai' : 'pearapi');
      setApiKeySet(!!v.api_key_set);
      setApiKeyMasked(String(v.api_key || ''));
      setApiKey('');
      setKeyDirty(false);
      setDub(String(v.dub || ''));
      setFormat(v.format === 'mp3' ? 'mp3' : 'ogg');
      setQqCharacter(String(v.qq_character || ''));
      setQqRefGroup(String(v.qq_ref_group || ''));
      setMaxChars(Number(v.max_chars) || 150);
      toast('语音配置已保存', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setSaving(false);
    }
  }, [api, toast, engine, dub, format, qqCharacter, qqRefGroup, maxChars, keyDirty, apiKey]);

  return (
    <section className="mkai-page-voice">
      <div className="panel stagger-item stagger-2">
        <h2 className="panel-title">语音输出</h2>

        {loading ? (
          <p className="mk-hint">加载中…</p>
        ) : (
          <>
            <div className="mk-form-group">
              <label className="mk-label">语音引擎</label>
              <div className="mk-seg mk-seg--fill" role="group" aria-label="语音引擎">
                <button
                  type="button"
                  className={`mk-seg__btn${engine === 'pearapi' ? ' mk-seg__btn--active' : ''}`}
                  aria-pressed={engine === 'pearapi'}
                  onClick={() => setEngine('pearapi')}
                >
                  第三方配音
                </button>
                <button
                  type="button"
                  className={`mk-seg__btn${engine === 'qqai' ? ' mk-seg__btn--active' : ''}`}
                  aria-pressed={engine === 'qqai'}
                  onClick={() => setEngine('qqai')}
                >
                  QQAI配音
                </button>
              </div>
            </div>

            {engine === 'pearapi' ? (
              <>
                <div className="mk-form-group" style={{ marginTop: 14 }}>
                  <label className="mk-label">配音密钥（可选）</label>
                  <input
                    type="text"
                    className="mk-input"
                    placeholder={apiKeySet ? `已设置：${apiKeyMasked}（留空不改动）` : '留空使用内置体验额度'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyDirty(true);
                    }}
                  />
                  <p className="mk-hint">
                    默认使用插件内置的体验额度，无需填写。若要用自己的账号，填入密钥后优先使用；
                    {apiKeySet ? '清空并保存可改回内置额度。' : ''}
                  </p>
                  <a
                    className="mk-link-out"
                    href={PEARAPI_HOME}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    前往官网获取密钥
                    <span className="mk-link-out__arrow" aria-hidden>↗</span>
                  </a>
                </div>

                <div className="mk-form-group" style={{ marginTop: 14 }}>
                  <label className="mk-label">配音角色</label>
                  <div className="mk-model-picker" ref={pickerRef}>
                    <div className="mk-input-with-action">
                      <input
                        type="text"
                        className="mk-input"
                        placeholder={`角色名，如「${DEFAULT_VOICE_DUB}」；点右侧按钮拉取全部角色`}
                        value={dub}
                        onChange={(e) => setDub(e.target.value)}
                      />
                      <button
                        type="button"
                        className="mk-input-with-action__btn"
                        title="拉取角色列表"
                        disabled={fetchingRoles}
                        onClick={() => void fetchRoles()}
                      >
                        {fetchingRoles ? '…' : '↻'}
                      </button>
                    </div>
                    {roleListOpen && roles.length > 0 ? (
                      <div className="mk-model-list" role="listbox" aria-label="配音角色列表">
                        <div className="mk-model-list__head">
                          <span>{filteredRoles.length}/{roles.length} 个角色</span>
                          <button type="button" className="mk-model-list__close" aria-label="关闭" onClick={() => setRoleListOpen(false)}>×</button>
                        </div>
                        <div style={{ padding: '6px 8px' }}>
                          <input type="text" className="mk-input" placeholder="搜索角色…" value={roleSearch} onChange={(e) => setRoleSearch(e.target.value)} />
                        </div>
                        <ul className="mk-model-list__items">
                          {filteredRoles.slice(0, 200).map((name) => (
                            <li key={name}>
                              <button
                                type="button"
                                className="mk-model-list__item"
                                role="option"
                                aria-selected={dub === name}
                                onClick={() => { setDub(name); setRoleListOpen(false); toast(`已选择 ${name}`, 'ok'); }}
                              >
                                {name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  <p className="mk-hint">
                    留空则默认使用「{DEFAULT_VOICE_DUB}」，保存后生效。
                  </p>
                  {dub.trim() ? null : (
                    <button
                      type="button"
                      className="mk-btn mk-btn--ghost"
                      onClick={() => setDub(DEFAULT_VOICE_DUB)}
                    >
                      填入默认角色「{DEFAULT_VOICE_DUB}」
                    </button>
                  )}
                </div>

                <div className="mk-form-group" style={{ marginTop: 14 }}>
                  <label className="mk-label">音频格式</label>
                  <select className="mk-input" value={format} onChange={(e) => setFormat(e.target.value === 'mp3' ? 'mp3' : 'ogg')}>
                    <option value="ogg">ogg（更贴合 QQ 语音）</option>
                    <option value="mp3">mp3</option>
                  </select>
                </div>
              </>
            ) : (
              <>
                <div className="mk-form-group" style={{ marginTop: 14 }}>
                  <label className="mk-label">参考群号（拉取角色用）</label>
                  <input
                    type="text"
                    className="mk-input"
                    inputMode="numeric"
                    placeholder="填一个机器人已在的群号，用来列出可用的 QQ AI 角色"
                    value={qqRefGroup}
                    onChange={(e) => setQqRefGroup(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                  <p className="mk-hint">QQ AI 角色列表按群拉取；这里只用于列举，实际发送用的是当前对话所在群。</p>
                </div>

                <div className="mk-form-group" style={{ marginTop: 14 }}>
                  <label className="mk-label">QQ AI 角色</label>
                  <div className="mk-model-picker" ref={qqPickerRef}>
                    <div className="mk-input-with-action">
                      <input
                        type="text"
                        className="mk-input"
                        placeholder="角色 id（character）；点右侧按钮按参考群拉取"
                        value={qqCharacter}
                        onChange={(e) => setQqCharacter(e.target.value)}
                      />
                      <button
                        type="button"
                        className="mk-input-with-action__btn"
                        title="拉取 QQ AI 角色"
                        disabled={fetchingQq}
                        onClick={() => void fetchQqChars()}
                      >
                        {fetchingQq ? '…' : '↻'}
                      </button>
                    </div>
                    {qqListOpen && qqChars.length > 0 ? (
                      <div className="mk-model-list" role="listbox" aria-label="QQ AI 角色列表">
                        <div className="mk-model-list__head">
                          <span>{filteredQq.length}/{qqChars.length} 个角色</span>
                          <button type="button" className="mk-model-list__close" aria-label="关闭" onClick={() => setQqListOpen(false)}>×</button>
                        </div>
                        <div style={{ padding: '6px 8px' }}>
                          <input type="text" className="mk-input" placeholder="搜索角色…" value={qqSearch} onChange={(e) => setQqSearch(e.target.value)} />
                        </div>
                        <ul className="mk-model-list__items">
                          {filteredQq.slice(0, 200).map((c) => (
                            <li key={c.id}>
                              <button
                                type="button"
                                className="mk-model-list__item"
                                role="option"
                                aria-selected={qqCharacter === c.id}
                                onClick={() => { setQqCharacter(c.id); setQqListOpen(false); toast(`已选择 ${c.name}`, 'ok'); }}
                              >
                                {c.name}
                                <span style={{ opacity: 0.55, marginLeft: 8, fontSize: 12 }}>{c.group}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  <p className="mk-hint">未选择角色时，即便开了语音开关也只会按文本发送。私聊不支持 QQ AI 语音，会自动回退文本。</p>
                </div>
              </>
            )}

            <div className="mk-form-group" style={{ marginTop: 14 }}>
              <label className="mk-label">单条语音最大字符数</label>
              <input
                type="number"
                className="mk-input"
                min={30}
                max={150}
                value={maxChars}
                onChange={(e) => setMaxChars(Number(e.target.value) || 150)}
              />
              <p className="mk-hint">净化后超过该长度的语音气泡改按文本发送；上限 150。</p>
            </div>

            <div className="mk-btn-row">
              <button type="button" className="mk-btn mk-btn--primary" disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : '保存'}
              </button>
              <button type="button" className="mk-btn mk-btn--ghost" disabled={loading} onClick={() => void load()}>
                重新加载
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
