import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bot,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clipboard,
  FileCode,
  FileText,
  Globe,
  Loader2,
  Play,
  Plug,
  RefreshCw,
  Rocket,
  Square,
  Wand2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import type { Account, Provider } from '@shared/types'
import {
  type RpaBrowser,
  type RpaAnalysisReport,
  type RpaCapturedRequest,
  type RpaLearningSessionSummary,
  type RpaPatchPreview,
  type RpaProgressEvent,
  type RpaAutomationStepResult,
  type RpaTarget,
} from '../../../shared/rpa'

export function RpaLearning() {
  const { t } = useTranslation()
  const [browser, setBrowser] = useState<RpaBrowser>('chrome')
  const [port, setPort] = useState(9222)
  const [isBusy, setIsBusy] = useState(false)
  const [connectionText, setConnectionText] = useState('')
  const [targets, setTargets] = useState<RpaTarget[]>([])
  const [selectedTargetId, setSelectedTargetId] = useState('')
  const [providers, setProviders] = useState<Provider[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [providerId, setProviderId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [session, setSession] = useState<RpaLearningSessionSummary | null>(null)
  const [captured, setCaptured] = useState<RpaCapturedRequest[]>([])
  const [patch, setPatch] = useState<RpaPatchPreview | null>(null)
  const [report, setReport] = useState<RpaAnalysisReport | null>(null)
  const [progress, setProgress] = useState<RpaProgressEvent | null>(null)
  const [error, setError] = useState('')
  const [providerUrl, setProviderUrl] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [automationSteps, setAutomationSteps] = useState<RpaAutomationStepResult[]>([])

  const providerAccounts = useMemo(
    () => providerId ? accounts.filter((account) => account.providerId === providerId) : [],
    [accounts, providerId],
  )
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId),
    [providers, providerId],
  )

  useEffect(() => {
    void loadProviders()

    const unsubscribeProgress = window.electronAPI?.rpa?.onProgress?.((event) => {
      setProgress(event)
      const step = event.data?.step as RpaAutomationStepResult | undefined
      if (step?.step) {
        setAutomationSteps((current) => upsertStep(current, step))
      }
      if (event.status === 'error') {
        setError(event.message)
      }
    })
    const unsubscribeCaptured = window.electronAPI?.rpa?.onRequestCaptured?.((event) => {
      setCaptured((current) => [event.request, ...current].slice(0, 100))
    })

    return () => {
      unsubscribeProgress?.()
      unsubscribeCaptured?.()
    }
  }, [])

  const loadProviders = async () => {
    const [providerList, builtinProviderList, accountList] = await Promise.all([
      window.electronAPI?.providers?.getAll?.() || Promise.resolve([]),
      window.electronAPI?.providers?.getBuiltin?.() || Promise.resolve([]),
      window.electronAPI?.accounts?.getAll?.() || Promise.resolve([]),
    ])
    const mergedProviders = mergeProviderReferences(providerList, builtinProviderList as Provider[])
    setProviders(mergedProviders)
    setAccounts(accountList)
    if (!providerId) {
      const preferredProvider = mergedProviders.find((provider) =>
        provider.enabled && ['doubao', 'yuanbao'].includes(provider.id),
      )
      if (preferredProvider) {
        setProviderId(preferredProvider.id)
      }
    }
  }

  const runAction = async (action: () => Promise<void>) => {
    setIsBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsBusy(false)
    }
  }

  const launchBrowser = () => runAction(async () => {
    const result = await window.electronAPI.rpa.launchBrowser({ browser, port })
    setConnectionText(result.connected
      ? `${result.browser || browser} ${t('rpa.connectedOnPort', { port: result.port })}`
      : result.error || t('rpa.connectionFailed'))
    if (result.connected) {
      await refreshTargets()
    }
  })

  const connectBrowser = () => runAction(async () => {
    const result = await window.electronAPI.rpa.connectBrowser({ port })
    setConnectionText(result.connected
      ? `${result.browser || browser} ${t('rpa.connectedOnPort', { port: result.port })}`
      : result.error || t('rpa.connectionFailed'))
    if (result.connected) {
      await refreshTargets()
    }
  })

  const refreshTargets = async () => {
    const list = await window.electronAPI.rpa.listTargets()
    setTargets(list)
    if (!selectedTargetId && list.length > 0) {
      setSelectedTargetId(list[0].id)
    }
  }

  const startLearning = () => runAction(async () => {
    setCaptured([])
    setPatch(null)
    const nextSession = await window.electronAPI.rpa.startLearning({
      targetId: selectedTargetId,
      providerId: selectedProvider?.id,
      accountId: selectedProvider ? accountId || undefined : undefined,
      prompt: prompt || undefined,
      timeoutMs: 120000,
    })
    setSession(nextSession)
  })

  const startRecording = () => runAction(async () => {
    setCaptured([])
    setPatch(null)
    setReport(null)
    setAutomationSteps([])
    const nextSession = await window.electronAPI.rpa.startRecording({
      providerId: selectedProvider?.id,
      accountId: selectedProvider ? accountId || undefined : undefined,
      providerUrl: selectedProvider ? undefined : providerUrl || undefined,
      browser,
      port,
      timeoutMs: 300000,
    })
    setSession(nextSession)
  })

  const startAutoLearning = () => runAction(async () => {
    setCaptured([])
    setPatch(null)
    setReport(null)
    setAutomationSteps([])
    const nextSession = await window.electronAPI.rpa.startAutoLearning({
      targetId: selectedTargetId,
      providerId: selectedProvider?.id,
      accountId: selectedProvider ? accountId || undefined : undefined,
      prompt: prompt || undefined,
      timeoutMs: 180000,
      answerTimeoutMs: 140000,
      shareTimeoutMs: 45000,
      share: true,
    })
    setSession(nextSession)
    setAutomationSteps(nextSession.result?.automationSteps || [])
  })

  const stopLearning = () => runAction(async () => {
    const nextSession = await window.electronAPI.rpa.stopLearning()
    setSession(nextSession || session)
  })

  const generateReport = () => runAction(async () => {
    if (!session) return
    const nextReport = await window.electronAPI.rpa.generateReport(session.id)
    setReport(nextReport)
    const nextSession = await window.electronAPI.rpa.getSession(session.id)
    setSession(nextSession || session)
  })

  const copyReport = () => runAction(async () => {
    const currentReport = report || session?.report
    if (!currentReport) return
    await navigator.clipboard.writeText(currentReport.markdown)
  })

  const generatePatch = () => runAction(async () => {
    if (!session) return
    const preview = await window.electronAPI.rpa.generatePatch(session.id)
    setPatch(preview)
    const nextSession = await window.electronAPI.rpa.getSession(session.id)
    setSession(nextSession || session)
  })

  const applyPatch = () => runAction(async () => {
    if (!session || !patch) return
    const confirmed = window.confirm(t('rpa.applyConfirm'))
    if (!confirmed) return
    const applied = await window.electronAPI.rpa.applyPatch(session.id)
    setPatch(applied)
    const nextSession = await window.electronAPI.rpa.getSession(session.id)
    setSession(nextSession || session)
  })

  const selectedTarget = targets.find((target) => target.id === selectedTargetId)
  const findings = session?.result?.findings || []
  const shownAutomationSteps = session?.result?.automationSteps || automationSteps
  const isCapturing = session?.status === 'capturing'
  const shownReport = report || session?.report || null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t('rpa.title')}</h2>
          <p className="text-muted-foreground">{t('rpa.subtitle')}</p>
        </div>
        {progress && (
          <div className="text-sm text-muted-foreground">
            {progress.message}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Play className="h-4 w-4" />
              {t('rpa.recording')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rpa-provider">{t('rpa.providerReference')}</Label>
              <Select value={selectedProvider ? providerId : 'none'} onValueChange={(value) => {
                const nextProviderId = value === 'none' ? '' : value
                setProviderId(nextProviderId)
                setAccountId('')
                if (nextProviderId) {
                  setProviderUrl('')
                }
              }}>
                <SelectTrigger id="rpa-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('rpa.noReference')}</SelectItem>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!selectedProvider && (
              <div className="space-y-2">
                <Label htmlFor="rpa-provider-url">{t('rpa.providerUrl')}</Label>
                <Input
                  id="rpa-provider-url"
                  value={providerUrl}
                  onChange={(event) => setProviderUrl(event.target.value)}
                  placeholder={t('rpa.providerUrlPlaceholder')}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="rpa-account">{t('rpa.accountReference')}</Label>
              <Select
                value={accountId || 'none'}
                onValueChange={(value) => setAccountId(value === 'none' ? '' : value)}
                disabled={!selectedProvider}
              >
                <SelectTrigger id="rpa-account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('rpa.noReference')}</SelectItem>
                  {providerAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              className="w-full"
              onClick={startRecording}
              disabled={isBusy || isCapturing || (!selectedProvider && !providerUrl.trim())}
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              <span>{t('rpa.startRecording')}</span>
            </Button>

            <div className="grid gap-3">
              <Metric label={t('rpa.status')} value={session?.status || 'idle'} />
              <Metric label={t('rpa.captured')} value={String(captured.length || session?.capturedCount || 0)} />
              <Metric label={t('rpa.confidence')} value={patch ? `${patch.confidence}%` : '-'} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4" />
              {t('rpa.analysis')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={stopLearning} disabled={!isCapturing}>
                <Square className="h-4 w-4" />
                <span>{t('rpa.stopAndAnalyze')}</span>
              </Button>
              <Button variant="outline" onClick={generateReport} disabled={!session || isCapturing || isBusy}>
                <FileText className="h-4 w-4" />
                <span>{t('rpa.generateReport')}</span>
              </Button>
              <Button variant="outline" onClick={copyReport} disabled={!shownReport || isBusy}>
                <Clipboard className="h-4 w-4" />
                <span>{t('rpa.copyReport')}</span>
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Metric label={t('rpa.status')} value={session?.status || 'idle'} />
              <Metric label={t('rpa.captured')} value={String(captured.length || session?.capturedCount || 0)} />
              <Metric label={t('rpa.findings')} value={String(findings.length)} />
            </div>
            {shownReport ? (
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-4 text-xs">
                {shownReport.markdown}
              </pre>
            ) : (
              <EmptyState text={t('rpa.noReport')} />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <button
              type="button"
              className="flex items-center gap-2"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <Plug className="h-4 w-4" />
              <span>{t('rpa.advancedMode')}</span>
            </button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-label={t('rpa.advancedMode')}
              title={t('rpa.advancedMode')}
            >
              {advancedOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </CardTitle>
        </CardHeader>
        {advancedOpen && (
          <CardContent className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="rpa-browser">{t('rpa.browser')}</Label>
                <Select value={browser} onValueChange={(value) => setBrowser(value as RpaBrowser)}>
                  <SelectTrigger id="rpa-browser">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="chrome">Chrome</SelectItem>
                    <SelectItem value="edge">Edge</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rpa-port">{t('rpa.port')}</Label>
                <Input
                  id="rpa-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(event) => setPort(Number(event.target.value) || 9222)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button onClick={launchBrowser} disabled={isBusy}>
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                <span>{t('rpa.launch')}</span>
              </Button>
              <Button variant="outline" onClick={connectBrowser} disabled={isBusy}>
                <Plug className="h-4 w-4" />
                <span>{t('rpa.connect')}</span>
              </Button>
            </div>

            {connectionText && (
              <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                {connectionText}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="rpa-target">{t('rpa.targetTab')}</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void refreshTargets()}
                  aria-label={t('common.refresh')}
                  title={t('common.refresh')}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              <Select value={selectedTargetId} onValueChange={setSelectedTargetId}>
                <SelectTrigger id="rpa-target">
                  <SelectValue placeholder={t('rpa.selectTarget')} />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((target) => (
                    <SelectItem key={target.id} value={target.id}>
                      {target.title || target.url || target.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTarget && (
                <div className="truncate text-xs text-muted-foreground">
                  {selectedTarget.url}
                </div>
              )}
            </div>
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={startLearning} disabled={!selectedTargetId || isBusy || isCapturing}>
                    <Play className="h-4 w-4" />
                    <span>{t('rpa.start')}</span>
                  </Button>
                  <Button onClick={startAutoLearning} disabled={!selectedTargetId || isBusy || isCapturing}>
                    <Bot className="h-4 w-4" />
                    <span>{t('rpa.autoRun')}</span>
                  </Button>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rpa-prompt">{t('rpa.prompt')}</Label>
                  <Textarea
                    id="rpa-prompt"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder={t('rpa.promptPlaceholder')}
                    rows={3}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('rpa.advancedHint')}
                </div>
                <AutomationTimeline steps={shownAutomationSteps} emptyText={t('rpa.noTimeline')} />
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      <Tabs defaultValue="findings">
        <TabsList>
          <TabsTrigger value="findings">
            <Globe className="mr-2 h-4 w-4" />
            {t('rpa.findings')}
          </TabsTrigger>
          <TabsTrigger value="requests">{t('rpa.requests')}</TabsTrigger>
          <TabsTrigger value="report">{t('rpa.report')}</TabsTrigger>
          <TabsTrigger value="patch">{t('rpa.patch')}</TabsTrigger>
        </TabsList>
        <TabsContent value="findings" className="mt-4">
          <div className="space-y-3">
            {findings.length === 0 ? (
              <EmptyState text={t('rpa.noFindings')} />
            ) : findings.map((finding) => (
              <div key={`${finding.kind}-${finding.url}`} className="rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">
                    {finding.kind.toUpperCase()} · {finding.method} · {finding.confidence}%
                  </div>
                  {finding.isStreaming && (
                    <span className="rounded bg-emerald-500/10 px-2 py-1 text-xs text-emerald-600">
                      SSE
                    </span>
                  )}
                </div>
                <div className="mt-2 break-all text-sm text-muted-foreground">{finding.path}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {finding.reasons.map((reason) => (
                    <span key={reason} className="rounded bg-muted px-2 py-1 text-xs">
                      {reason}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="requests" className="mt-4">
          <div className="space-y-3">
            {captured.length === 0 ? (
              <EmptyState text={t('rpa.noRequests')} />
            ) : captured.map((request) => (
              <div key={request.id} className="rounded-md border p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{request.method}</span>
                  <span>{request.status || '-'}</span>
                  <span>{request.resourceType}</span>
                  {request.isEventStream && <span className="text-emerald-600">SSE</span>}
                </div>
                <div className="mt-2 break-all text-sm text-muted-foreground">{request.url}</div>
              </div>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="report" className="mt-4">
          {!shownReport ? (
            <EmptyState text={t('rpa.noReport')} />
          ) : (
            <pre className="max-h-[680px] overflow-auto rounded-md border p-4 text-xs">
              {shownReport.markdown}
            </pre>
          )}
        </TabsContent>
        <TabsContent value="patch" className="mt-4">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={generatePatch} disabled={!session || isBusy}>
                <Wand2 className="h-4 w-4" />
                <span>{t('rpa.generatePatch')}</span>
              </Button>
              <Button onClick={applyPatch} disabled={!patch?.canApply || isBusy}>
                <FileCode className="h-4 w-4" />
                <span>{t('rpa.applyPatch')}</span>
              </Button>
            </div>
            {!patch ? (
              <EmptyState text={t('rpa.noPatch')} />
            ) : (
              <>
              <div className="flex items-center gap-2 rounded-md border p-4">
                <CheckCircle className="h-5 w-5 text-emerald-600" />
                <div>
                  <div className="font-medium">{patch.summary}</div>
                  {patch.warnings.length > 0 && (
                    <div className="text-sm text-muted-foreground">{patch.warnings.join(' ')}</div>
                  )}
                </div>
              </div>
              {patch.files.map((file) => (
                <div key={file.path} className="rounded-md border">
                  <div className="border-b px-4 py-2 text-sm font-medium">{file.path}</div>
                  <pre className="max-h-96 overflow-auto p-4 text-xs">
                    {file.content}
                  </pre>
                </div>
              ))}
              </>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function mergeProviderReferences(configuredProviders: Provider[], builtinProviders: Provider[]): Provider[] {
  const configuredIds = new Set(configuredProviders.map((provider) => provider.id))
  const missingBuiltinProviders = builtinProviders.filter((provider) => !configuredIds.has(provider.id))
  return [...configuredProviders, ...missingBuiltinProviders]
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  )
}

function AutomationTimeline({
  steps,
  emptyText,
}: {
  steps: RpaAutomationStepResult[]
  emptyText: string
}) {
  if (steps.length === 0) {
    return <EmptyState text={emptyText} />
  }

  return (
    <div className="space-y-3">
      {steps.map((step) => (
        <div key={step.step} className="flex gap-3 rounded-md border px-4 py-3">
          <div className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${step.success ? 'bg-emerald-500' : 'bg-destructive'}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium">{step.step}</div>
              {typeof step.confidence === 'number' && (
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {step.confidence}%
                </span>
              )}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">{step.message}</div>
            {step.targetLabel && (
              <div className="mt-1 break-all text-xs text-muted-foreground">{step.targetLabel}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}

function upsertStep(
  current: RpaAutomationStepResult[],
  next: RpaAutomationStepResult,
): RpaAutomationStepResult[] {
  const index = current.findIndex((step) => step.step === next.step)
  if (index === -1) {
    return [...current, next]
  }

  return current.map((step, itemIndex) => itemIndex === index ? next : step)
}

export default RpaLearning
