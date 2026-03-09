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

function Get-MissingLocalBins {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [Parameter(Mandatory = $true)]
    [string[]]$Names
  )

  $binDir = Join-Path $RepoRoot "node_modules/.bin"
  $missing = @()

  foreach ($name in $Names) {
    $found = $false
    foreach ($candidate in @("$name.cmd", "$name.ps1", $name)) {
      if (Test-Path (Join-Path $binDir $candidate)) {
        $found = $true
        break
      }
    }
    if (-not $found) {
      $missing += $name
    }
  }

  return $missing
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

function Find-ReleaseByTagCandidates {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ApiBase,
    [Parameter(Mandatory = $true)]
    [hashtable]$Headers,
    [Parameter(Mandatory = $true)]
    [string[]]$TagCandidates,
    [int]$Attempts = 5,
    [int]$DelaySeconds = 2
  )

  for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
    foreach ($tag in $TagCandidates) {
      try {
        return Invoke-RestMethod -Method Get -Uri "$ApiBase/releases/tags/$tag" -Headers $Headers
      } catch {
        $statusCode = Get-HttpStatusCode -ErrorRecord $_
        if ($statusCode -ne 404) {
          throw
        }
      }
    }

    if ($attempt -lt $Attempts) {
      Start-Sleep -Seconds $DelaySeconds
    }
  }

  return $null
}

function Ensure-GitHubRelease {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ApiBase,
    [Parameter(Mandatory = $true)]
    [hashtable]$Headers,
    [Parameter(Mandatory = $true)]
    [string[]]$TagCandidates,
    [bool]$CreateAsDraft
  )

  $release = Find-ReleaseByTagCandidates -ApiBase $ApiBase -Headers $Headers -TagCandidates $TagCandidates
  if ($release) {
    return $release
  }

  foreach ($tagName in $TagCandidates) {
    $body = @{
      tag_name = $tagName
      name = $tagName
      draft = $CreateAsDraft
      prerelease = $false
      generate_release_notes = $false
    } | ConvertTo-Json

    try {
      Write-Host "==> Creating GitHub release: $tagName"
      return Invoke-RestMethod -Method Post -Uri "$ApiBase/releases" -Headers $Headers -ContentType "application/json" -Body $body
    } catch {
      $statusCode = Get-HttpStatusCode -ErrorRecord $_
      if ($statusCode -eq 422) {
        # Another process may have created the release concurrently; fetch again.
        $release = Find-ReleaseByTagCandidates -ApiBase $ApiBase -Headers $Headers -TagCandidates $TagCandidates -Attempts 3 -DelaySeconds 2
        if ($release) {
          return $release
        }

        continue
      }
      throw
    }
  }

  throw "Could not create or find a GitHub release for tags: $($TagCandidates -join ', ')."
}

function Upload-ReleaseAsset {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ApiBase,
    [Parameter(Mandatory = $true)]
    [hashtable]$Headers,
    [Parameter(Mandatory = $true)]
    [object]$Release,
    [Parameter(Mandatory = $true)]
    [string]$AssetPath,
    [Parameter(Mandatory = $true)]
    [string]$AssetName,
    [string]$ContentType = "application/octet-stream"
  )

  if (-not (Test-Path $AssetPath)) {
    throw "Asset file not found: $AssetPath"
  }

  $existingAsset = @($Release.assets) | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
  if ($existingAsset) {
    Invoke-RestMethod -Method Delete -Uri "$ApiBase/releases/assets/$($existingAsset.id)" -Headers $Headers | Out-Null
  }

  $uploadUrlBase = ([string]$Release.upload_url) -replace "\{\?name,label\}$", ""
  $uploadUrl = "$uploadUrlBase?name=$([uri]::EscapeDataString($AssetName))"
  $uploadHeaders = @{
    Authorization = [string]$Headers.Authorization
    Accept = [string]$Headers.Accept
    "X-GitHub-Api-Version" = [string]$Headers."X-GitHub-Api-Version"
    "User-Agent" = [string]$Headers."User-Agent"
    "Content-Type" = $ContentType
  }

  Write-Host "==> Uploading asset: $AssetName"
  return Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $uploadHeaders -InFile $AssetPath
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

foreach ($cmd in @("npm", "git", "tar")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Required command '$cmd' is not available in PATH."
  }
}

$token = [string]$env:GH_TOKEN
if (-not $token -or $token.Trim().Length -eq 0) {
  throw "GH_TOKEN is not set. In PowerShell run: `$env:GH_TOKEN='your_github_token' and re-run npm run release:win:auto."
}

$requiredLocalBins = @("vite", "tsup", "electron-builder")
$missingBins = @(Get-MissingLocalBins -RepoRoot $repoRoot -Names $requiredLocalBins)
if ($missingBins.Count -gt 0) {
  Write-Host "==> Missing local tool(s): $($missingBins -join ', ')"
  Invoke-CheckedCommand -FilePath "npm" -Arguments @("ci", "--include=dev") -Description "Install project dependencies (including dev dependencies)"
  $missingBins = @(Get-MissingLocalBins -RepoRoot $repoRoot -Names $requiredLocalBins)
  if ($missingBins.Count -gt 0) {
    throw "Missing required local tools after install: $($missingBins -join ', ')."
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
    Write-Host "==> No staged version changes. Skipping commit and push."
  } else {
    Invoke-CheckedCommand -FilePath "git" -Arguments @("commit", "-m", "release: v$nextVersion") -Description "Commit version bump"

    if (-not $SkipPush) {
      Invoke-CheckedCommand -FilePath "git" -Arguments @("push") -Description "Push release commit"
    }
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

$tagCandidates = @("v$nextVersion", $nextVersion) | Select-Object -Unique
$release = Ensure-GitHubRelease -ApiBase $apiBase -Headers $githubHeaders -TagCandidates $tagCandidates -CreateAsDraft ([bool]$KeepDraft)

$productName = [string]$packageJson.build.productName
if (-not $productName) {
  $productName = "ButTherefore"
}
$setupExeName = "$productName-Setup-$nextVersion.exe"
$setupExePath = Join-Path $releaseDir $setupExeName
$setupBlockmapName = "$setupExeName.blockmap"
$setupBlockmapPath = Join-Path $releaseDir $setupBlockmapName
$latestYmlName = "latest.yml"
$latestYmlPath = Join-Path $releaseDir $latestYmlName

$portableZipName = [System.IO.Path]::GetFileName($portableZipPath)
$assetsToUpload = @(
  @{
    Name = $setupExeName
    Path = $setupExePath
    Required = $true
    ContentType = "application/vnd.microsoft.portable-executable"
  },
  @{
    Name = $setupBlockmapName
    Path = $setupBlockmapPath
    Required = $false
    ContentType = "application/octet-stream"
  },
  @{
    Name = $latestYmlName
    Path = $latestYmlPath
    Required = $true
    ContentType = "application/x-yaml"
  },
  @{
    Name = $portableZipName
    Path = $portableZipPath
    Required = $true
    ContentType = "application/zip"
  }
)

$uploadedZipAsset = $null
foreach ($asset in $assetsToUpload) {
  $name = [string]$asset.Name
  $path = [string]$asset.Path
  $required = [bool]$asset.Required
  $contentType = [string]$asset.ContentType

  if (-not (Test-Path $path)) {
    if ($required) {
      throw "Required release asset not found: $path"
    }
    Write-Host "==> Optional asset not found, skipping: $name"
    continue
  }

  $uploaded = Upload-ReleaseAsset -ApiBase $apiBase -Headers $githubHeaders -Release $release -AssetPath $path -AssetName $name -ContentType $contentType
  if ($name -eq $portableZipName) {
    $uploadedZipAsset = $uploaded
  }
}

if (-not $KeepDraft) {
  $publishBody = @{
    draft = $false
    prerelease = $false
  } | ConvertTo-Json

  $release = Invoke-RestMethod -Method Patch -Uri "$apiBase/releases/$($release.id)" -Headers $githubHeaders -ContentType "application/json" -Body $publishBody
}

$tagName = [string]$release.tag_name
$setupUrl = "https://github.com/$owner/$repo/releases/download/$tagName/$setupExeName"
$zipUrl = if ($uploadedZipAsset) { [string]$uploadedZipAsset.browser_download_url } else { "https://github.com/$owner/$repo/releases/download/$tagName/$portableZipName" }

Write-Host ""
Write-Host "Release complete."
Write-Host "Release URL: $($release.html_url)"
Write-Host "Installer URL: $setupUrl"
Write-Host "Portable ZIP URL: $zipUrl"
