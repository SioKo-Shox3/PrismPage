import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Download, ExternalLink, RefreshCw, Rocket } from 'lucide-react'

interface GitHubReleaseAsset {
  browser_download_url: string
  name: string
}

interface GitHubRelease {
  assets: GitHubReleaseAsset[]
  body?: string
  draft?: boolean
  html_url: string
  name?: string
  prerelease?: boolean
  published_at?: string
  tag_name: string
}

interface ParsedVersion {
  parts: number[]
  prerelease: string[]
}

const fallbackVersion = '0.1.0'
const releasesApiUrl = 'https://api.github.com/repos/SioKo-Shox3/PrismPage/releases?per_page=20'
const installerAssetPattern = /\.(exe|msi|msix)$/i

function stripDistributionPrefix(version: string) {
  return version.trim().replace(/^app-v/i, '').replace(/^v/i, '')
}

function normalizeVersion(version: string) {
  return stripDistributionPrefix(version)
}

function parseVersion(version: string): ParsedVersion {
  const withoutBuild = stripDistributionPrefix(version).split('+')[0] ?? fallbackVersion
  const prereleaseIndex = withoutBuild.indexOf('-')
  const core = prereleaseIndex >= 0 ? withoutBuild.slice(0, prereleaseIndex) : withoutBuild
  const prereleaseText = prereleaseIndex >= 0 ? withoutBuild.slice(prereleaseIndex + 1) : ''

  return {
    parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
    prerelease: prereleaseText.split(/[.-]/).filter(Boolean),
  }
}

function comparePrereleaseParts(left: string[], right: string[]) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]

    if (leftPart === undefined) {
      return rightPart === undefined ? 0 : -1
    }

    if (rightPart === undefined) {
      return 1
    }

    const leftIsNumeric = /^\d+$/.test(leftPart)
    const rightIsNumeric = /^\d+$/.test(rightPart)

    if (leftIsNumeric && rightIsNumeric) {
      const diff = Number.parseInt(leftPart, 10) - Number.parseInt(rightPart, 10)
      if (diff !== 0) {
        return diff
      }
      continue
    }

    if (leftIsNumeric !== rightIsNumeric) {
      return leftIsNumeric ? -1 : 1
    }

    const diff = leftPart.localeCompare(rightPart)
    if (diff !== 0) {
      return diff
    }
  }

  return 0
}

function compareVersions(left: string, right: string) {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  const length = Math.max(leftVersion.parts.length, rightVersion.parts.length, 3)

  for (let index = 0; index < length; index += 1) {
    const diff = (leftVersion.parts[index] ?? 0) - (rightVersion.parts[index] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) {
    return 1
  }

  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) {
    return -1
  }

  return comparePrereleaseParts(leftVersion.prerelease, rightVersion.prerelease)
}

function isPrismPageDistributionTag(tagName: string) {
  return /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?$/i.test(
    stripDistributionPrefix(tagName).split('+')[0] ?? '',
  )
}

function pickLatestDistributionRelease(releases: GitHubRelease[]) {
  const candidates = releases.filter(
    (release) => release.draft !== true && isPrismPageDistributionTag(release.tag_name),
  )

  return candidates.sort((left, right) => {
    const versionDiff = compareVersions(right.tag_name, left.tag_name)
    if (versionDiff !== 0) {
      return versionDiff
    }

    return Date.parse(right.published_at ?? '') - Date.parse(left.published_at ?? '')
  })[0] ?? null
}

async function resolveCurrentVersion() {
  try {
    return await getVersion()
  } catch {
    return fallbackVersion
  }
}

async function fetchReleases() {
  const response = await fetch(releasesApiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  })

  if (response.status === 404) {
    return []
  }

  if (!response.ok) {
    throw new Error(`GitHub Releases の確認に失敗しました: ${response.status}`)
  }

  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) {
    throw new Error('GitHub Releases の応答形式を読み取れませんでした。')
  }

  return payload as GitHubRelease[]
}

async function openExternalUrl(url: string) {
  try {
    await openUrl(url)
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

export function UpdateChecker() {
  const [currentVersion, setCurrentVersion] = useState(fallbackVersion)
  const [release, setRelease] = useState<GitHubRelease | null>(null)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    void resolveCurrentVersion().then((version) => {
      if (mounted) {
        setCurrentVersion(version)
      }
    })

    return () => {
      mounted = false
    }
  }, [])

  const installerAssets =
    release?.assets.filter((asset) => installerAssetPattern.test(asset.name)) ?? []
  const hasUpdate =
    release && currentVersion ? compareVersions(release.tag_name, currentVersion) > 0 : false

  async function handleCheckUpdate() {
    try {
      setChecking(true)
      setMessage(null)
      setError(null)

      const version = await resolveCurrentVersion()
      const releases = await fetchReleases()
      const latestRelease = pickLatestDistributionRelease(releases)

      setCurrentVersion(version)
      setRelease(latestRelease)

      if (!latestRelease) {
        setMessage(
          '公開済みの PrismPage 配布リリースは見つかりませんでした。ドラフトのままでは表示されません。',
        )
        return
      }

      setMessage(
        compareVersions(latestRelease.tag_name, version) > 0
          ? `新しい配布版 ${normalizeVersion(latestRelease.tag_name)} があります。`
          : `利用中のバージョンは最新相当です。現在のバージョン: ${version}`,
      )
    } catch (checkError) {
      setError(
        checkError instanceof Error
          ? checkError.message
          : 'アップデート確認に失敗しました。',
      )
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="panel update-checker">
      <div className="section-header">
        <Rocket size={18} />
        <div>
          <h2>アプリ更新</h2>
          <p>GitHub Releases の公開済み配布版を確認します。公開済み prerelease も対象です。</p>
        </div>
      </div>

      <div className="update-checker-body">
        <div className="inline-actions">
          <button
            type="button"
            className="button"
            onClick={() => void handleCheckUpdate()}
            disabled={checking}
            aria-busy={checking}
          >
            <RefreshCw size={16} />
            {checking ? '確認中...' : 'アップデートを確認'}
          </button>
          <span className="status-chip">現在: {currentVersion}</span>
          {release ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() => void openExternalUrl(release.html_url)}
            >
              <ExternalLink size={16} />
              配布ページを開く
            </button>
          ) : null}
        </div>

        <p className="helper-text">
          ドラフトや公開前のリリースは GitHub の公開 API には表示されません。
        </p>

        {message ? (
          <div className={`message-strip ${hasUpdate ? 'is-success' : ''}`}>{message}</div>
        ) : null}
        {error ? <div className="message-strip is-error">{error}</div> : null}

        {release ? (
          <>
            <div className="update-checker-meta">
              <div>
                <span className="eyebrow">Current</span>
                <strong>{currentVersion}</strong>
                <span className="muted">インストール中</span>
              </div>
              <div>
                <span className="eyebrow">Release</span>
                <strong>{normalizeVersion(release.tag_name)}</strong>
                <span className="muted">{release.prerelease ? 'prerelease' : 'release'}</span>
              </div>
              <div>
                <span className="eyebrow">Installer</span>
                <strong>{installerAssets.length}</strong>
                <span className="muted">候補ファイル</span>
              </div>
            </div>

            {installerAssets.length > 0 ? (
              <div className="installer-list" aria-label="インストーラ候補">
                {installerAssets.map((asset) => (
                  <button
                    key={asset.browser_download_url}
                    type="button"
                    className="ghost-button"
                    onClick={() => void openExternalUrl(asset.browser_download_url)}
                  >
                    <Download size={16} />
                    <span>{asset.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="message-strip">
                このリリースに .exe / .msi / .msix のインストーラ asset は見つかりませんでした。
                配布ページで内容を確認してください。
              </div>
            )}
          </>
        ) : null}
      </div>
    </section>
  )
}
