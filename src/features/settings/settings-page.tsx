import { BookOpenText, ImageUpscale, Settings2, Sparkles } from 'lucide-react'

import { EngineManager } from '@/features/ai-installer/engine-manager'
import { useSettingsStore } from '@/features/settings/settings-store'
import { UpdateChecker } from '@/features/settings/update-checker'
import { engineOptions } from '@/lib/engines'

export function SettingsPage() {
  const {
    autoEnhanceVisibleImages,
    autoEnhanceZoomedImage,
    enhancementEnabled,
    fontScale,
    lineHeight,
    precomputeBookImages,
    preferredEngine,
    setAutoEnhanceZoomedImage,
    setAutoEnhanceVisibleImages,
    setEnhancementEnabled,
    setFontScale,
    setLineHeight,
    setPrecomputeBookImages,
    setPreferredEngine,
    setTheme,
    setZoomEnhancementScale,
    theme,
    zoomEnhancementScale,
  } = useSettingsStore()

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Settings</span>
          <h1>読書設定</h1>
          <p>表示、バックグラウンド高精細化、既定エンジンをまとめて調整します。</p>
        </div>
      </header>

      <section className="panel">
        <div className="section-header">
          <BookOpenText size={18} />
          <div>
            <h2>表示と AI</h2>
            <p>読書中は本文領域を優先し、必要な設定だけここにまとめます。</p>
          </div>
        </div>

        <div className="settings-compact-grid">
          <article className="setting-item">
            <div className="setting-item-header">
              <Sparkles size={18} />
              <div>
                <h3>テーマ</h3>
                <p>UI カラーを即座に切り替えます。</p>
              </div>
            </div>

            <div className="segmented-control">
              {[
                { label: 'Dark', value: 'dark' },
                { label: 'Light', value: 'light' },
                { label: 'Sepia', value: 'sepia' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="segmented-button"
                  onClick={() => setTheme(option.value as typeof theme)}
                  disabled={theme === option.value}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </article>

          <article className="setting-item">
            <div className="setting-item-header">
              <Settings2 size={18} />
              <div>
                <h3>本文スケール</h3>
                <p>epub.js のレンダリングに反映する設定です。</p>
              </div>
            </div>

            <label className="field-label">
              文字サイズ {fontScale}%
              <input
                type="range"
                min={85}
                max={150}
                step={5}
                value={fontScale}
                onChange={(event) => setFontScale(Number(event.target.value))}
              />
            </label>

            <label className="field-label">
              行間 {lineHeight.toFixed(1)}
              <input
                type="range"
                min={1.2}
                max={2}
                step={0.1}
                value={lineHeight}
                onChange={(event) => setLineHeight(Number(event.target.value))}
              />
            </label>
          </article>

          <article className="setting-item">
            <div className="setting-item-header">
              <ImageUpscale size={18} />
              <div>
                <h3>バックグラウンド高精細化</h3>
                <p>元画像で読みながら、読書を邪魔しない速度で全ページを高精細化します。</p>
              </div>
            </div>

            <label className="field-label">
              有効 / 無効
              <select
                value={enhancementEnabled ? 'enabled' : 'disabled'}
                onChange={(event) => setEnhancementEnabled(event.target.value === 'enabled')}
              >
                <option value="enabled">有効</option>
                <option value="disabled">無効</option>
              </select>
            </label>

            <label className="field-label">
              適用倍率
              <select
                value={zoomEnhancementScale}
                onChange={(event) => setZoomEnhancementScale(Number(event.target.value))}
              >
                <option value={2}>2x</option>
                <option value={3}>3x</option>
                <option value={4}>4x</option>
              </select>
            </label>

            <label className="field-label">
              全ページの事前処理
              <select
                value={precomputeBookImages ? 'precompute' : 'visible'}
                onChange={(event) =>
                  setPrecomputeBookImages(event.target.value === 'precompute')
                }
              >
                <option value="precompute">読書優先で実行</option>
                <option value="visible">開いたページだけ</option>
              </select>
            </label>

            <label className="field-label">
              読書中の表示画像
              <select
                value={autoEnhanceVisibleImages ? 'auto' : 'off'}
                onChange={(event) =>
                  setAutoEnhanceVisibleImages(event.target.value === 'auto')
                }
              >
                <option value="auto">完了した画像から差し替え</option>
                <option value="off">元画像のまま</option>
              </select>
            </label>

            <label className="field-label">
              拡大表示を開いた画像
              <select
                value={autoEnhanceZoomedImage ? 'auto' : 'manual'}
                onChange={(event) =>
                  setAutoEnhanceZoomedImage(event.target.value === 'auto')
                }
              >
                <option value="auto">アイドル時に自動実行</option>
                <option value="manual">手動実行</option>
              </select>
            </label>
          </article>

          <article className="setting-item">
            <div className="setting-item-header">
              <Sparkles size={18} />
              <div>
                <h3>既定エンジン</h3>
                <p>読書中の自動高精細化に使うエンジンです。</p>
              </div>
            </div>

            <div className="segmented-control">
              {engineOptions.map((engine) => (
                <button
                  key={engine.id}
                  type="button"
                  className="segmented-button"
                  onClick={() => setPreferredEngine(engine.id)}
                  disabled={preferredEngine === engine.id}
                >
                  {engine.label}
                </button>
              ))}
            </div>
          </article>
        </div>
      </section>

      <UpdateChecker />

      <EngineManager
        preferredEngine={preferredEngine}
        onPreferredEngineChange={setPreferredEngine}
      />
    </div>
  )
}
