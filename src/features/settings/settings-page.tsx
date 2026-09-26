import { useState } from 'react'
import type { ReactNode } from 'react'

import { AiSettings } from '@/features/settings/ai-settings'
import { EngineSettings } from '@/features/settings/engine-settings'
import { LegacyDataSettings } from '@/features/settings/legacy-data-settings'
import { LibrarySourceSettings } from '@/features/library/source-settings'
import { useSettingsStore } from '@/features/settings/settings-store'
import { themeOptions } from '@/features/settings/theme'
import { UpdateChecker } from '@/features/settings/update-checker'
import type { Binding, SpreadMode } from '@/types/app'

import styles from './settings-page.module.css'

// 設定の区分(spec 3.6)。`id` はページ内リンクの行き先で、AI 超解像の `ai-engines` は
// 左ナビとビューアからのリンクが使う。
const SECTIONS = [
  { id: 'display', numeral: '一', title: '表示' },
  { id: 'controls', numeral: '二', title: '操作' },
  { id: 'library', numeral: '三', title: 'ライブラリ' },
  { id: 'ai-engines', numeral: '四', title: 'AI 超解像' },
  { id: 'about', numeral: '五', title: 'アプリ情報' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsPage() {
  const {
    defaultBinding,
    defaultCoverSingle,
    defaultSpreadMode,
    setDefaultBinding,
    setDefaultCoverSingle,
    setDefaultSpreadMode,
    setTheme,
    setViewerFullscreen,
    setWheelReversed,
    theme,
    viewerFullscreen,
    wheelReversed,
  } = useSettingsStore()
  // エンジンの登録が変わったら、AI 超解像の既定値の欄にエンジンの状態を読み直させる。
  const [engineRevision, setEngineRevision] = useState(0)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>設定</h1>
        <p className={styles.lead}>表示と操作、ライブラリ、AI 超解像、アプリの情報をまとめて調整します。</p>
      </header>

      <div className={styles.layout}>
        <nav className={styles.toc} aria-label="設定の区分">
          <ol>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>
                  <span className={styles.tocNumeral} aria-hidden="true">
                    {section.numeral}
                  </span>
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className={styles.sections}>
          <SettingsSection id="display" lead="テーマと、本を開いたときの見せ方です。">
            <div className="settings-compact-grid">
              <article className="setting-item">
                <div className="setting-item-header">
                  <div>
                    <h3>テーマ</h3>
                    <p>生成り色の「紙」、夜向けの「墨」、OS の明暗に合わせる設定から選びます。</p>
                  </div>
                </div>

                <div className="segmented-control" role="group" aria-label="テーマ">
                  {themeOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="segmented-button"
                      onClick={() => setTheme(option.value)}
                      disabled={theme === option.value}
                      aria-pressed={theme === option.value}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </article>

              <article className="setting-item">
                <div className="setting-item-header">
                  <div>
                    <h3>本の表示の既定値</h3>
                    <p>
                      ビューアで変えた表示は本ごとに記憶します。まだ変えていない本はここの設定で開きます
                      (綴じ方向を指定している EPUB はその向き)。
                    </p>
                  </div>
                </div>

                <label className="field-label">
                  見開き
                  <select
                    value={defaultSpreadMode}
                    onChange={(event) => setDefaultSpreadMode(event.target.value as SpreadMode)}
                  >
                    <option value="auto">自動(横長のウィンドウで見開き)</option>
                    <option value="spread">見開き</option>
                    <option value="single">単ページ</option>
                  </select>
                </label>

                <label className="field-label">
                  綴じ方向
                  <select
                    value={defaultBinding}
                    onChange={(event) => setDefaultBinding(event.target.value as Binding)}
                  >
                    <option value="right">右綴じ</option>
                    <option value="left">左綴じ</option>
                  </select>
                </label>

                <label className="field-label">
                  表紙
                  <select
                    value={defaultCoverSingle ? 'single' : 'paired'}
                    onChange={(event) => setDefaultCoverSingle(event.target.value === 'single')}
                  >
                    <option value="single">単独で表示する</option>
                    <option value="paired">次のページと並べる</option>
                  </select>
                </label>
              </article>

              <article className="setting-item">
                <div className="setting-item-header">
                  <div>
                    <h3>ビューア</h3>
                    <p>オフにしても、ビューアで F / F11 を押すと全画面とウィンドウを切り替えられます。</p>
                  </div>
                </div>

                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={viewerFullscreen}
                    onChange={(event) => setViewerFullscreen(event.target.checked)}
                  />
                  ビューアを全画面で開く
                </label>
              </article>
            </div>
          </SettingsSection>

          <SettingsSection id="controls" lead="ビューアでページを送る操作です。">
            <div className="settings-compact-grid">
              <article className="setting-item">
                <div className="setting-item-header">
                  <div>
                    <h3>マウスホイール</h3>
                    <p>ホイールでページを送る向きを選びます。</p>
                  </div>
                </div>

                <label className="field-label">
                  ホイールの向き
                  <select
                    value={wheelReversed ? 'reversed' : 'normal'}
                    onChange={(event) => setWheelReversed(event.target.value === 'reversed')}
                  >
                    <option value="normal">下へ回すと次のページ</option>
                    <option value="reversed">上へ回すと次のページ</option>
                  </select>
                </label>
              </article>
            </div>
          </SettingsSection>

          <SettingsSection id="library" lead="登録したフォルダの本が、フォルダの一覧と検索に出ます。">
            <LibrarySourceSettings />
          </SettingsSection>

          <SettingsSection
            id="ai-engines"
            lead="ビューアで AI を ON にしたときの処理と、超解像に使うエンジンの導入です。"
          >
            <AiSettings engineRevision={engineRevision} />
            <EngineSettings onStatusesChange={() => setEngineRevision((revision) => revision + 1)} />
          </SettingsSection>

          <SettingsSection id="about" lead="アプリの更新と、旧バージョンが残したデータの整理です。">
            <UpdateChecker />
            <LegacyDataSettings />
          </SettingsSection>
        </div>
      </div>
    </div>
  )
}

function SettingsSection({ id, lead, children }: { id: SectionId; lead: string; children: ReactNode }) {
  const section = SECTIONS.find((candidate) => candidate.id === id)!
  const headingId = `${id}-heading`

  return (
    <section id={id} className={styles.section} aria-labelledby={headingId}>
      <header className={styles.sectionHeader}>
        <span className={styles.numeral} aria-hidden="true">
          {section.numeral}
        </span>
        <div>
          <h2 id={headingId} className={styles.sectionTitle}>
            {section.title}
          </h2>
          <p className={styles.sectionLead}>{lead}</p>
        </div>
      </header>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  )
}
