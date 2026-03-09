param(
  [ValidateSet("patch", "minor", "major", "none")]
  [string]$Bump = "patch",
  [string]$Version = "",
  [switch]$SkipCommit,
  [switch]$SkipPush,
  [switch]$KeepDraft
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$Description = ""
  )

  $label = if ($Description) { $Description } else { "$FilePath $($Arguments -join ' ')" }
  Write-Host "==> $label"
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $label"
  }
}

function Read-PackageJson {
  param([Parameter(Mandatory = $true)][string]$Path)
  return Get-Content $Path -Raw | ConvertFrom-Json
}

function Get-HttpStatusCode {
  param([Parameter(Mandatory = $true)]$ErrorRecord)
  $response = $ErrorRecord.Exception.Response
  if ($null -eq $response) {
    return $null
  }

  try {
    return [int]$response.StatusCode
  } catch {
    return $null
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

foreach ($cmd in @("npm", "git", "tar")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Required command '$cmd' is not available in PATH."
  }
}

$initialStatus = (& git status --porcelain)
if ($LASTEXITCODE -ne 0) {
  throw "Failed to read git status."
}
if ($initialStatus -and ($initialStatus | Out-String).Trim().Length -gt 0) {
  throw "Working tree is not clean. Commit or stash your changes first."
}

$packageJsonPath = Join-Path $repoRoot "package.json"
$packageLockPath = Join-Path $repoRoot "package-lock.json"

if ($Version) {
  $normalizedVersion = $Version.Trim()
  if ($normalizedVersion.StartsWith("v")) {
    $normalizedVersion = $normalizedVersion.Substring(1)
  }
  Invoke-CheckedCommand -FilePath "npm" -Arguments @("version", $normalizedVersion, "--no-git-tag-version") -Description "Set version to $normalizedVersion"
} elseif ($Bump -ne "none") {
  Invoke-CheckedCommand -FilePath "npm" -Arguments @("version", $Bump, "--no-git-tag-version") -Description "Bump version ($Bump)"
} else {
  Write-Host "==> Skipping version bump"
}

$packageJson = Read-PackageJson -Path $packageJsonPath
$nextVersion = [string]$packageJson.version
if (-not $nextVersion) {
  throw "Could not read project version from package.json."
}
Write-Host "==> Release version: $nextVersion"

if (-not $SkipCommit) {
  $pathsToStage = @($packageJsonPath)
  if (Test-Path $packageLockPath) {
    $pathsToStage += $packageLockPath
  }

  $gitAddArgs = @("add") + $pathsToStage
  Invoke-CheckedCommand -FilePath "git" -Arguments $gitAddArgs -Description "Stage version files"

  $stagedFiles = (& git diff --cached --name-only)
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to read staged files."
  }
  if (-not $stagedFiles -or ($stagedFiles | Out-String).Trim().Length -eq 0) {
    throw "No staged changes found for commit."
  }

  Invoke-CheckedCommand -FilePath "git" -Arguments @("commit", "-m", "release: v$nextVersion") -Description "Commit version bump"

  if (-not $SkipPush) {
    Invoke-CheckedCommand -FilePath "git" -Arguments @("push") -Description "Push release commit"
  }
} elseif (-not $SkipPush) {
  Write-Host "==> SkipCommit is set; skipping push."
}

Invoke-CheckedCommand -FilePath "npm" -Arguments @("run", "release:win") -Description "Build and publish installer artifacts"

$releaseDir = Join-Path $repoRoot "release"
$winUnpackedDir = Join-Path $releaseDir "win-unpacked"
$portableZipPath = Join-Path $releaseDir "ButTherefore-Windows-Portable.zip"

if (-not (Test-Path $winUnpackedDir)) {
  throw "Expected folder '$winUnpackedDir' was not found."
}

if (Test-Path $portableZipPath) {
  Remove-Item $portableZipPath -Force
}

Invoke-CheckedCommand -FilePath "tar" -Arguments @("-a", "-cf", $portableZipPath, "-C", $releaseDir, "win-unpacked") -Description "Create portable ZIP"

$token = $env:GH_TOKEN
if (-not $token) {
  throw "GH_TOKEN is required to upload the ZIP asset."
}

$publishEntries = @($packageJson.build.publish)
$githubPublishTarget = $publishEntries | Where-Object { $_.provider -eq "github" } | Select-Object -First 1
if (-not $githubPublishTarget) {
  throw "No GitHub publish target found in package.json build.publish."
}

$owner = [string]$githubPublishTarget.owner
$repo = [string]$githubPublishTarget.repo
if (-not $owner -or -not $repo) {
  throw "GitHub publish target is missing owner/repo."
}

$apiBase = "https://api.github.com/repos/$owner/$repo"
$githubHeaders = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "buttherefore-release-script"
}

$release = $null
$tagCandidates = @("v$nextVersion", $nextVersion) | Select-Object -Unique
foreach ($tag in $tagCandidates) {
  try {
    $release = Invoke-RestMethod -Method Get -Uri "$apiBase/releases/tags/$tag" -Headers $githubHeaders
    break
  } catch {
    $statusCode = Get-HttpStatusCode -ErrorRecord $_
    if ($statusCode -ne 404) {
      throw
    }
  }
}

if (-not $release) {
  throw "Could not find GitHub release for tags: $($tagCandidates -join ', ')."
}

$portableZipName = [System.IO.Path]::GetFileName($portableZipPath)
$existingAsset = @($release.assets) | Where-Object { $_.name -eq $portableZipName } | Select-Object -First 1
if ($existingAsset) {
  Invoke-RestMethod -Method Delete -Uri "$apiBase/releases/assets/$($existingAsset.id)" -Headers $githubHeaders | Out-Null
}

$uploadUrlBase = ([string]$release.upload_url) -replace "\{\?name,label\}$", ""
$uploadUrl = "$uploadUrlBase?name=$([uri]::EscapeDataString($portableZipName))"
$uploadHeaders = @{
  Authorization = "Bearer $token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "buttherefore-release-script"
  "Content-Type" = "application/zip"
}

$uploadedAsset = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $uploadHeaders -InFile $portableZipPath

if (-not $KeepDraft) {
  $publishBody = @{
    draft = $false
    prerelease = $false
  } | ConvertTo-Json

  $release = Invoke-RestMethod -Method Patch -Uri "$apiBase/releases/$($release.id)" -Headers $githubHeaders -ContentType "application/json" -Body $publishBody
}

$tagName = [string]$release.tag_name
$productName = [string]$packageJson.build.productName
if (-not $productName) {
  $productName = "ButTherefore"
}
$setupExeName = "$productName-Setup-$nextVersion.exe"
$setupUrl = "https://github.com/$owner/$repo/releases/download/$tagName/$setupExeName"
$zipUrl = [string]$uploadedAsset.browser_download_url

Write-Host ""
Write-Host "Release complete."
Write-Host "Release URL: $($release.html_url)"
Write-Host "Installer URL: $setupUrl"
Write-Host "Portable ZIP URL: $zipUrl"
