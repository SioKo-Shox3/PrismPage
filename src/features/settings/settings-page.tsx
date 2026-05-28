import { Settings2, Sparkles } from 'lucide-react'

import { EngineManager } from '@/features/ai-installer/engine-manager'
import { useSettingsStore } from '@/features/settings/settings-store'

export function SettingsPage() {
  const {
    autoEnhanceZoomedImage,
    enhancementEnabled,
    fontScale,
    lineHeight,
    preferredEngine,
    setAutoEnhanceZoomedImage,
    setEnhancementEnabled,
    setFontScale,
    setLineHeight,
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
          <h1>読書と AI の設定</h1>
          <p>テーマ、文字サイズ、AI エンジン、拡大時の高精細化動作をここで調整します。</p>
        </div>
      </header>

      <section className="panel">
        <div className="section-header">
          <Settings2 size={18} />
          <div>
            <h2>読書体験</h2>
            <p>アプリ全体の見た目と本文レイアウトを調整します。</p>
          </div>
        </div>

        <div className="settings-grid">
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
              <Sparkles size={18} />
              <div>
                <h3>AI 高精細化</h3>
                <p>画像モーダル内の高精細化挙動を決めます。</p>
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
              拡大倍率
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
              画像モーダルを開いたときに自動実行
              <select
                value={autoEnhanceZoomedImage ? 'auto' : 'manual'}
                onChange={(event) =>
                  setAutoEnhanceZoomedImage(event.target.value === 'auto')
                }
              >
                <option value="manual">手動実行</option>
                <option value="auto">自動実行</option>
              </select>
            </label>
          </article>

          <article className="setting-item">
            <div className="setting-item-header">
              <Sparkles size={18} />
              <div>
                <h3>既定エンジン</h3>
                <p>画像モーダルの既定値です。必要に応じて個別に切り替えできます。</p>
              </div>
            </div>

            <div className="segmented-control">
              <button
                type="button"
                className="segmented-button"
                onClick={() => setPreferredEngine('waifu2x')}
                disabled={preferredEngine === 'waifu2x'}
              >
                waifu2x
              </button>
              <button
                type="button"
                className="segmented-button"
                onClick={() => setPreferredEngine('real-esrgan')}
                disabled={preferredEngine === 'real-esrgan'}
              >
                Real-ESRGAN
              </button>
            </div>
          </article>
        </div>
      </section>

      <EngineManager
        preferredEngine={preferredEngine}
        onPreferredEngineChange={setPreferredEngine}
      />
    </div>
  )
}
