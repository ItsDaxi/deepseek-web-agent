# Answers the native folder dialog through UI Automation, so no keystrokes can reach another window.
# With -Path it picks that folder; without it, it cancels.
param(
  [string]$Path = '',
  [string]$Title = 'Choose working directory',
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$automation = [Windows.Automation.AutomationElement]
$property = [Windows.Automation.AutomationElement]::NameProperty
$byTitle = [Windows.Automation.PropertyCondition]::new($property, $Title)
$byId = { param($id) [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $id) }

$dialog = $null
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (-not $dialog -and (Get-Date) -lt $deadline) {
  # An owned dialog can sit under its owner in the tree rather than directly under the desktop.
  $dialog = $automation::RootElement.FindFirst([Windows.Automation.TreeScope]::Descendants, $byTitle)
  if (-not $dialog) { Start-Sleep -Milliseconds 200 }
}
if (-not $dialog) { throw 'The folder dialog did not appear.' }
Start-Sleep -Milliseconds 500

$scope = [Windows.Automation.TreeScope]::Descendants
if ($Path) {
  # 1148 is the file name box and 1 is the accept button in the common item dialog.
  $edit = $dialog.FindFirst($scope, (& $byId '1148'))
  if (-not $edit) { throw 'The file name box was not found.' }
  $edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Path)
  $button = $dialog.FindFirst($scope, (& $byId '1'))
} else {
  $button = $dialog.FindFirst($scope, (& $byId '2'))
}
if (-not $button) { throw 'The dialog button was not found.' }
$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
