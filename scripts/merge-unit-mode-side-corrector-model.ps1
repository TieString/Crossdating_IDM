param(
    [Parameter(Mandatory = $true)]
    [string]$BaseModel,
    [Parameter(Mandatory = $true)]
    [string]$CandidateModel,
    [Parameter(Mandatory = $true)]
    [ValidateSet("missingRing", "falseRing")]
    [string]$EventType,
    [Parameter(Mandatory = $true)]
    [string]$OutputModel
)

$base = Get-Content -LiteralPath $BaseModel -Raw | ConvertFrom-Json
$candidate = Get-Content -LiteralPath $CandidateModel -Raw | ConvertFrom-Json
$replacement = $candidate.eventTypes.$EventType
if ($null -eq $replacement) {
    throw "Candidate model does not contain $EventType"
}

$base.eventTypes.$EventType = $replacement
$base | ConvertTo-Json -Depth 100 -Compress | Set-Content -LiteralPath $OutputModel -Encoding utf8NoBOM
