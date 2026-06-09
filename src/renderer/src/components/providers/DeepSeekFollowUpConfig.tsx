import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BellPlus, CheckSquare, RotateCcw, Save, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import type { Account, DeepSeekPostShareFollowUpConfig } from '@/types/electron'
import {
  buildDeepSeekFollowUpFeatureConfig,
  getDeepSeekFollowUpStatus,
  removeDeepSeekFollowUpFeatureConfig,
  resolveDeepSeekFollowUpConfig,
  validateDeepSeekFollowUpConfig,
} from '../../../../shared/deepseekFollowUp'

interface DeepSeekFollowUpStatusBadgeProps {
  account: Account
}

interface DeepSeekAccountFollowUpCardProps {
  account: Account
  defaultConfig: DeepSeekPostShareFollowUpConfig
  onUpdate: (updates: Partial<Account>) => Promise<void>
}

interface DeepSeekFollowUpBatchDialogProps {
  open: boolean
  accounts: Account[]
  defaultConfig: DeepSeekPostShareFollowUpConfig
  onOpenChange: (open: boolean) => void
  onAccountUpdated: (accountId: string, updates: Partial<Account>) => void
}

type FollowUpMode = 'inherit' | 'custom'

const statusClassName = {
  inherit: 'text-slate-600 bg-slate-100 border-slate-200',
  enabled: 'text-green-700 bg-green-100 border-green-200',
  disabled: 'text-orange-700 bg-orange-100 border-orange-200',
}

function createFormConfig(config: DeepSeekPostShareFollowUpConfig): DeepSeekPostShareFollowUpConfig {
  return {
    enabled: config.enabled,
    prompts: [
      config.prompts[0] ?? '',
      config.prompts[1] ?? '',
    ],
    delayMs: config.delayMs,
  }
}

function useFollowUpValidation(config: DeepSeekPostShareFollowUpConfig) {
  const { t } = useTranslation()
  return useMemo(() => validateDeepSeekFollowUpConfig(config, {
    promptRequired: t('deepseek.followUp.validation.promptRequired'),
    delayNonNegative: t('deepseek.followUp.validation.delayNonNegative'),
  }), [config, t])
}

function FollowUpConfigFields({
  value,
  onChange,
  disabled,
}: {
  value: DeepSeekPostShareFollowUpConfig
  onChange: (value: DeepSeekPostShareFollowUpConfig) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const validation = useFollowUpValidation(value)

  const updatePrompt = (index: number, prompt: string) => {
    const prompts = [...value.prompts]
    prompts[index] = prompt
    onChange({
      ...value,
      prompts,
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="space-y-1">
          <Label>{t('deepseek.followUp.enabled')}</Label>
          <p className="text-xs text-muted-foreground">{t('deepseek.followUp.enabledHint')}</p>
        </div>
        <Switch
          checked={value.enabled}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ ...value, enabled: checked })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="deepseek-follow-up-prompt-1">
          {t('deepseek.followUp.prompt1')}
        </Label>
        <Textarea
          id="deepseek-follow-up-prompt-1"
          value={value.prompts[0] ?? ''}
          disabled={disabled}
          rows={3}
          onChange={(event) => updatePrompt(0, event.target.value)}
        />
        {validation.promptErrors[0] && (
          <p className="text-xs text-destructive">{validation.promptErrors[0]}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="deepseek-follow-up-prompt-2">
          {t('deepseek.followUp.prompt2')}
        </Label>
        <Textarea
          id="deepseek-follow-up-prompt-2"
          value={value.prompts[1] ?? ''}
          disabled={disabled}
          rows={3}
          onChange={(event) => updatePrompt(1, event.target.value)}
        />
        {validation.promptErrors[1] && (
          <p className="text-xs text-destructive">{validation.promptErrors[1]}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="deepseek-follow-up-delay">
          {t('deepseek.followUp.delayMs')}
        </Label>
        <Input
          id="deepseek-follow-up-delay"
          type="number"
          min={0}
          value={value.delayMs}
          disabled={disabled}
          onChange={(event) => onChange({
            ...value,
            delayMs: Number(event.target.value),
          })}
        />
        {validation.delayMsError && (
          <p className="text-xs text-destructive">{validation.delayMsError}</p>
        )}
      </div>
    </div>
  )
}

export function DeepSeekFollowUpStatusBadge({ account }: DeepSeekFollowUpStatusBadgeProps) {
  const { t } = useTranslation()
  const status = getDeepSeekFollowUpStatus(account)

  return (
    <Badge variant="outline" className={cn('text-xs', statusClassName[status])}>
      {t(`deepseek.followUp.status.${status}`)}
    </Badge>
  )
}

export function DeepSeekAccountFollowUpCard({
  account,
  defaultConfig,
  onUpdate,
}: DeepSeekAccountFollowUpCardProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const overrideConfig = account.featureConfig?.deepSeekPostShareFollowUp
  const [mode, setMode] = useState<FollowUpMode>(overrideConfig ? 'custom' : 'inherit')
  const [formConfig, setFormConfig] = useState(() =>
    createFormConfig(resolveDeepSeekFollowUpConfig(defaultConfig, account))
  )
  const [isSaving, setIsSaving] = useState(false)
  const validation = useFollowUpValidation(formConfig)
  const inheritedConfig = resolveDeepSeekFollowUpConfig(defaultConfig)

  useEffect(() => {
    const nextOverrideConfig = account.featureConfig?.deepSeekPostShareFollowUp
    setMode(nextOverrideConfig ? 'custom' : 'inherit')
    setFormConfig(createFormConfig(resolveDeepSeekFollowUpConfig(defaultConfig, account)))
  }, [account, defaultConfig])

  const handleSave = async () => {
    if (!validation.isValid) return

    setIsSaving(true)
    try {
      await onUpdate({
        featureConfig: buildDeepSeekFollowUpFeatureConfig(account.featureConfig, formConfig),
      })
      toast({
        title: t('deepseek.followUp.saved'),
        description: t('deepseek.followUp.accountSavedDesc'),
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleRestoreInherit = async () => {
    setIsSaving(true)
    try {
      await onUpdate({
        featureConfig: removeDeepSeekFollowUpFeatureConfig(account.featureConfig),
      })
      setMode('inherit')
      toast({
        title: t('deepseek.followUp.restored'),
        description: t('deepseek.followUp.restoreDesc'),
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BellPlus className="h-4 w-4" />
              {t('deepseek.followUp.title')}
            </CardTitle>
            <CardDescription>{t('deepseek.followUp.description')}</CardDescription>
          </div>
          <DeepSeekFollowUpStatusBadge account={account} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={mode} onValueChange={(value) => setMode(value as FollowUpMode)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="inherit">{t('deepseek.followUp.inheritDefault')}</TabsTrigger>
            <TabsTrigger value="custom">{t('deepseek.followUp.custom')}</TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'inherit' ? (
          <div className="space-y-3 rounded-md border bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('deepseek.followUp.effectiveStatus')}</span>
              <Badge variant={inheritedConfig.enabled ? 'default' : 'outline'}>
                {inheritedConfig.enabled ? t('deepseek.followUp.enabledShort') : t('deepseek.followUp.disabledShort')}
              </Badge>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">{t('deepseek.followUp.defaultPrompts')}</p>
              <p>{inheritedConfig.prompts[0]}</p>
              <p>{inheritedConfig.prompts[1]}</p>
            </div>
            <div className="flex items-center justify-between text-muted-foreground">
              <span>{t('deepseek.followUp.delayMs')}</span>
              <span>{inheritedConfig.delayMs}</span>
            </div>
          </div>
        ) : (
          <>
            <FollowUpConfigFields value={formConfig} onChange={setFormConfig} disabled={isSaving} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={handleRestoreInherit} disabled={isSaving || !overrideConfig}>
                <RotateCcw className="mr-2 h-4 w-4" />
                {t('deepseek.followUp.restoreInherit')}
              </Button>
              <Button onClick={handleSave} disabled={isSaving || !validation.isValid}>
                <Save className="mr-2 h-4 w-4" />
                {isSaving ? t('common.loading') : t('common.save')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function DeepSeekFollowUpBatchDialog({
  open,
  accounts,
  defaultConfig,
  onOpenChange,
  onAccountUpdated,
}: DeepSeekFollowUpBatchDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [formConfig, setFormConfig] = useState(() => createFormConfig(defaultConfig))
  const [isSaving, setIsSaving] = useState(false)
  const validation = useFollowUpValidation(formConfig)
  const hasSelectedAccounts = selectedIds.length > 0
  const allSelected = accounts.length > 0 && selectedIds.length === accounts.length

  useEffect(() => {
    if (!open) return
    setSelectedIds(accounts.map(account => account.id))
    setFormConfig(createFormConfig(defaultConfig))
  }, [accounts, defaultConfig, open])

  const toggleAccount = (accountId: string) => {
    setSelectedIds(prev => prev.includes(accountId)
      ? prev.filter(id => id !== accountId)
      : [...prev, accountId]
    )
  }

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : accounts.map(account => account.id))
  }

  const updateSelectedAccounts = async (updatesFor: (account: Account) => Partial<Account>) => {
    setIsSaving(true)
    let successCount = 0
    let failureCount = 0

    try {
      for (const accountId of selectedIds) {
        const account = accounts.find(item => item.id === accountId)
        if (!account) continue

        const updates = updatesFor(account)
        try {
          const updated = await window.electronAPI.accounts.update(account.id, updates)
          if (updated) {
            successCount += 1
            onAccountUpdated(account.id, updates)
          } else {
            failureCount += 1
          }
        } catch (error) {
          console.error('Failed to update DeepSeek follow-up config:', error)
          failureCount += 1
        }
      }

      toast({
        title: failureCount > 0
          ? t('deepseek.followUp.batchPartialSuccess')
          : t('deepseek.followUp.batchSaved'),
        description: t('deepseek.followUp.batchResult', {
          success: successCount,
          failed: failureCount,
        }),
        variant: failureCount > 0 ? 'destructive' : 'default',
      })

      if (successCount > 0 && failureCount === 0) {
        onOpenChange(false)
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleSave = async () => {
    if (!validation.isValid || !hasSelectedAccounts) return

    await updateSelectedAccounts(account => ({
      featureConfig: buildDeepSeekFollowUpFeatureConfig(account.featureConfig, formConfig),
    }))
  }

  const handleRestore = async () => {
    if (!hasSelectedAccounts) return

    await updateSelectedAccounts(account => ({
      featureConfig: removeDeepSeekFollowUpFeatureConfig(account.featureConfig),
    }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('deepseek.followUp.batchTitle')}</DialogTitle>
          <DialogDescription>{t('deepseek.followUp.batchDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)]">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{t('deepseek.followUp.selectAccounts')}</Label>
              <Button type="button" variant="outline" size="sm" onClick={toggleAll}>
                {allSelected ? (
                  <CheckSquare className="mr-2 h-4 w-4" />
                ) : (
                  <Square className="mr-2 h-4 w-4" />
                )}
                {t('deepseek.followUp.selectAll')}
              </Button>
            </div>
            <div className="max-h-80 space-y-2 overflow-auto rounded-md border p-2">
              {accounts.map(account => {
                const checked = selectedIds.includes(account.id)
                return (
                  <button
                    key={account.id}
                    type="button"
                    className={cn(
                      'flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      checked ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                    )}
                    onClick={() => toggleAccount(account.id)}
                  >
                    <span className="min-w-0 truncate font-medium">{account.name}</span>
                    <DeepSeekFollowUpStatusBadge account={account} />
                  </button>
                )
              })}
            </div>
            {!hasSelectedAccounts && (
              <p className="text-xs text-destructive">{t('deepseek.followUp.validation.selectAccount')}</p>
            )}
          </div>

          <FollowUpConfigFields value={formConfig} onChange={setFormConfig} disabled={isSaving} />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('common.cancel')}
          </Button>
          <Button variant="outline" onClick={handleRestore} disabled={isSaving || !hasSelectedAccounts}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {t('deepseek.followUp.restoreInherit')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !validation.isValid || !hasSelectedAccounts}>
            <Save className="mr-2 h-4 w-4" />
            {isSaving ? t('common.loading') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
