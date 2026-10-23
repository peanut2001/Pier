# Embedded as UTF-16 EncodedCommand, so Chinese messages work independently of
# the Windows system code page. User values are passed as data through env vars.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$engine = $null
try {
    Add-Type -AssemblyName System.Speech
    $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
    if ($recognizers.Count -eq 0) {
        throw '未找到 Windows 系统语音识别引擎，请在系统语言设置中安装语音组件，或切换自定义转写服务；也可在输入框按 Win + H'
    }
    $language = $env:PIER_SPEECH_LANGUAGE
    if ([string]::IsNullOrEmpty($language)) {
        $language = [System.Globalization.CultureInfo]::CurrentUICulture.Name
        $chosen = @($recognizers | Where-Object { $_.Culture.Name -eq $language })
        if ($chosen.Count -eq 0) { $chosen = $recognizers }
    } else {
        $chosen = @($recognizers | Where-Object { $_.Culture.Name -eq $language })
        if ($chosen.Count -eq 0) {
            throw '未安装所选语言的 Windows 系统语音识别引擎，请安装对应语音组件，选择跟随系统或切换自定义转写服务'
        }
    }
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($chosen[0])
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $text = New-Object 'System.Collections.Generic.List[string]'
    if (-not [string]::IsNullOrEmpty($env:PIER_SPEECH_AUDIO)) {
        # A silence/noise timeout must not drop the remainder of a recording.
        $engine.InitialSilenceTimeout = [TimeSpan]::Zero
        $engine.BabbleTimeout = [TimeSpan]::Zero
        $engine.SetInputToWaveFile($env:PIER_SPEECH_AUDIO)
        while ($null -ne ($result = $engine.Recognize())) {
            if (-not [string]::IsNullOrWhiteSpace($result.Text)) { $text.Add($result.Text) }
        }
    }
    @{ text = ($text -join ' '); error = $null } | ConvertTo-Json -Compress
} catch {
    # Only our actionable messages leave the process; do not expose paths or audio.
    $message = 'Windows 系统语音识别不可用，请检查已安装的语音组件或切换自定义转写服务；也可在输入框按 Win + H'
    if ($_.Exception.Message -match '^(未找到|未安装)') { $message = $_.Exception.Message }
    @{ text = ''; error = $message } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $engine) { $engine.Dispose() }
}
