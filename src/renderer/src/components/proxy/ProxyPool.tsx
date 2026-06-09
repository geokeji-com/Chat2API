import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import type { ProxyNode } from '@/types/electron'
import { parseProxyImportText } from '../../../../shared/proxyImport'
import { Activity, Clipboard, Edit, MapPin, Network, Plus, RefreshCw, Rows3, Trash2 } from 'lucide-react'

interface ProxyNodeForm {
  name: string
  host: string
  port: string
  username: string
  password: string
  province: string
  city: string
  regionCode: string
  enabled: boolean
}

const emptyForm: ProxyNodeForm = {
  name: '',
  host: '',
  port: '1080',
  username: '',
  password: '',
  province: '',
  city: '',
  regionCode: '',
  enabled: true,
}

function maskHost(node: ProxyNode): string {
  return `${node.host}:${node.port}`
}

function formatLocation(node: ProxyNode): string {
  return [node.province, node.city, node.regionCode].filter(Boolean).join(' / ')
}

export function ProxyPool() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [nodes, setNodes] = useState<ProxyNode[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [resolvingGeoId, setResolvingGeoId] = useState<string | null>(null)
  const [isResolvingAllGeo, setIsResolvingAllGeo] = useState(false)
  const [editingNode, setEditingNode] = useState<ProxyNode | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<ProxyNodeForm>(emptyForm)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [isImporting, setIsImporting] = useState(false)

  const importResult = useMemo(() => parseProxyImportText(importText), [importText])

  const loadNodes = async () => {
    setIsLoading(true)
    try {
      setNodes(await window.electronAPI.proxyPool.getAll())
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('proxyPool.loadFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadNodes()
  }, [])

  const openCreateDialog = () => {
    setEditingNode(null)
    setForm(emptyForm)
    setDialogOpen(true)
  }

  const openImportDialog = (text: string = '') => {
    setImportText(text)
    setImportDialogOpen(true)
  }

  const importFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      openImportDialog(text)
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('proxyPool.clipboardReadFailed'),
        variant: 'destructive',
      })
    }
  }

  const openEditDialog = async (node: ProxyNode) => {
    setEditingNode(node)
    const fullNode = await window.electronAPI.proxyPool.getById(node.id, true)
    setForm({
      name: fullNode?.name || node.name,
      host: fullNode?.host || node.host,
      port: String(fullNode?.port || node.port),
      username: fullNode?.username || '',
      password: fullNode?.password === '***' ? '' : fullNode?.password || '',
      province: fullNode?.province || '',
      city: fullNode?.city || '',
      regionCode: fullNode?.regionCode || '',
      enabled: fullNode?.enabled ?? node.enabled,
    })
    setDialogOpen(true)
  }

  const saveNode = async () => {
    const payload = {
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim() || undefined,
      password: form.password,
      province: form.province.trim() || undefined,
      city: form.city.trim() || undefined,
      regionCode: form.regionCode.trim() || undefined,
      enabled: form.enabled,
    }

    try {
      if (editingNode) {
        const updated = await window.electronAPI.proxyPool.update(editingNode.id, payload)
        if (updated) {
          setNodes(prev => prev.map(node => node.id === updated.id ? updated : node))
        }
      } else {
        const created = await window.electronAPI.proxyPool.add(payload)
        setNodes(prev => [...prev, created])
      }
      setDialogOpen(false)
      toast({ title: t('common.success'), description: t('proxyPool.saved') })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('proxyPool.saveFailed'),
        variant: 'destructive',
      })
    }
  }

  const toggleNode = async (node: ProxyNode) => {
    const updated = await window.electronAPI.proxyPool.update(node.id, { enabled: !node.enabled })
    if (updated) {
      setNodes(prev => prev.map(item => item.id === updated.id ? updated : item))
    }
  }

  const deleteNode = async (node: ProxyNode) => {
    const deleted = await window.electronAPI.proxyPool.delete(node.id)
    if (deleted) {
      setNodes(prev => prev.filter(item => item.id !== node.id))
    }
  }

  const testNode = async (node: ProxyNode) => {
    setTestingId(node.id)
    try {
      const result = await window.electronAPI.proxyPool.test(node.id)
      if (result.node) {
        setNodes(prev => prev.map(item => item.id === result.node!.id ? result.node! : item))
      }
      toast({
        title: result.success ? t('common.success') : t('common.error'),
        description: result.success
          ? t('proxyPool.testSuccess', { latency: result.latency || 0 })
          : result.error || t('proxyPool.testFailed'),
        variant: result.success ? 'default' : 'destructive',
      })
    } finally {
      setTestingId(null)
    }
  }

  const resolveNodeGeo = async (node: ProxyNode, force: boolean = false) => {
    setResolvingGeoId(node.id)
    try {
      const result = await window.electronAPI.proxyPool.resolveGeo(node.id, force)
      if (result.node) {
        setNodes(prev => prev.map(item => item.id === result.node!.id ? result.node! : item))
      }
      toast({
        title: result.success ? t('common.success') : t('common.error'),
        description: result.success
          ? t('proxyPool.geoResolved', {
            location: [result.geo?.province, result.geo?.city, result.geo?.regionCode].filter(Boolean).join(' / '),
          })
          : result.error || t('proxyPool.geoResolveFailed'),
        variant: result.success ? 'default' : 'destructive',
      })
    } finally {
      setResolvingGeoId(null)
    }
  }

  const resolveAllGeo = async () => {
    setIsResolvingAllGeo(true)
    try {
      const result = await window.electronAPI.proxyPool.resolveAllGeo(false)
      const resolvedNodes = result.results
        .map(item => item.node)
        .filter((item): item is ProxyNode => Boolean(item))
      if (resolvedNodes.length > 0) {
        const byId = new Map(resolvedNodes.map(node => [node.id, node]))
        setNodes(prev => prev.map(node => byId.get(node.id) || node))
      }
      toast({
        title: t('proxyPool.geoResolveComplete'),
        description: t('proxyPool.geoResolveResult', {
          resolved: result.resolved,
          skipped: result.skipped,
          failed: result.failed,
        }),
        variant: result.failed > 0 ? 'destructive' : 'default',
      })
    } finally {
      setIsResolvingAllGeo(false)
    }
  }

  const importNodes = async () => {
    const existingKeys = new Set(nodes.map(node => `${node.host}:${node.port}:${node.username || ''}`))
    const createdNodes: ProxyNode[] = []
    let skipped = 0
    let failed = 0

    setIsImporting(true)
    try {
      for (const node of importResult.nodes) {
        const key = `${node.host}:${node.port}:${node.username || ''}`
        if (existingKeys.has(key)) {
          skipped++
          continue
        }

        try {
          const created = await window.electronAPI.proxyPool.add({
            name: node.name,
            host: node.host,
            port: node.port,
            username: node.username,
            password: node.password,
            province: node.province,
            city: node.city,
            regionCode: node.regionCode,
            enabled: node.enabled,
          })
          existingKeys.add(key)
          createdNodes.push(created)
        } catch (error) {
          failed++
          console.error('Failed to import proxy node:', error)
        }
      }

      if (createdNodes.length > 0) {
        setNodes(prev => [...prev, ...createdNodes])
      }
      setImportDialogOpen(false)
      setImportText('')
      toast({
        title: t('proxyPool.importComplete'),
        description: t('proxyPool.importResult', {
          imported: createdNodes.length,
          skipped,
          failed,
        }),
        variant: failed > 0 ? 'destructive' : 'default',
      })
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" />
            <CardTitle>{t('proxyPool.title')}</CardTitle>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={loadNodes} disabled={isLoading}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={resolveAllGeo} disabled={isResolvingAllGeo || nodes.length === 0}>
              <MapPin className="h-4 w-4 mr-2" />
              {isResolvingAllGeo ? t('proxyPool.geoResolving') : t('proxyPool.resolveGeo')}
            </Button>
            <Button variant="outline" size="sm" onClick={importFromClipboard}>
              <Clipboard className="h-4 w-4 mr-2" />
              {t('proxyPool.importClipboard')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => openImportDialog()}>
              <Rows3 className="h-4 w-4 mr-2" />
              {t('proxyPool.batchImport')}
            </Button>
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="h-4 w-4 mr-2" />
              {t('proxyPool.addNode')}
            </Button>
          </div>
        </div>
        <CardDescription>{t('proxyPool.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('proxyPool.node')}</TableHead>
              <TableHead>{t('proxyPool.location')}</TableHead>
              <TableHead>{t('proxyPool.status')}</TableHead>
              <TableHead>{t('proxyPool.failures')}</TableHead>
              <TableHead className="text-right">{t('common.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map(node => (
              <TableRow key={node.id}>
                <TableCell>
                  <div className="font-medium">{node.name}</div>
                  <div className="text-xs text-muted-foreground">{maskHost(node)}</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatLocation(node) || '-'}
                </TableCell>
                <TableCell>
                  <Badge variant={node.status === 'active' ? 'default' : 'secondary'}>
                    {t(`proxyPool.statuses.${node.status}`)}
                  </Badge>
                </TableCell>
                <TableCell>{node.failureCount || 0}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => testNode(node)} disabled={testingId === node.id}>
                      <Activity className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => resolveNodeGeo(node, true)} disabled={resolvingGeoId === node.id}>
                      <MapPin className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => toggleNode(node)}>
                      <RefreshCw className={`h-4 w-4 ${node.enabled ? '' : 'opacity-40'}`} />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => openEditDialog(node)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => deleteNode(node)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {nodes.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  {t('proxyPool.empty')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingNode ? t('proxyPool.editNode') : t('proxyPool.addNode')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('proxyPool.name')}</Label>
              <Input value={form.name} onChange={(event) => setForm(prev => ({ ...prev, name: event.target.value }))} />
            </div>
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div className="space-y-2">
                <Label>{t('proxyPool.host')}</Label>
                <Input value={form.host} onChange={(event) => setForm(prev => ({ ...prev, host: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>{t('proxyPool.port')}</Label>
                <Input type="number" value={form.port} onChange={(event) => setForm(prev => ({ ...prev, port: event.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{t('proxyPool.username')}</Label>
                <Input value={form.username} onChange={(event) => setForm(prev => ({ ...prev, username: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>{t('proxyPool.password')}</Label>
                <Input type="password" value={form.password} onChange={(event) => setForm(prev => ({ ...prev, password: event.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label>{t('proxyPool.province')}</Label>
                <Input value={form.province} onChange={(event) => setForm(prev => ({ ...prev, province: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>{t('proxyPool.city')}</Label>
                <Input value={form.city} onChange={(event) => setForm(prev => ({ ...prev, city: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>{t('proxyPool.regionCode')}</Label>
                <Input placeholder="ZH-610100" value={form.regionCode} onChange={(event) => setForm(prev => ({ ...prev, regionCode: event.target.value }))} />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label>{t('proxyPool.enabled')}</Label>
              <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm(prev => ({ ...prev, enabled }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={saveNode}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>{t('proxyPool.batchImport')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('proxyPool.importText')}</Label>
              <Textarea
                className="min-h-[180px] font-mono text-xs"
                placeholder={t('proxyPool.importPlaceholder')}
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
              />
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">{t('proxyPool.detectedNodes')}</div>
                <div className="text-2xl font-semibold">{importResult.nodes.length}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">{t('proxyPool.detectedIssues')}</div>
                <div className="text-2xl font-semibold">{importResult.issues.length}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">{t('proxyPool.detectedLines')}</div>
                <div className="text-2xl font-semibold">{importResult.totalLines}</div>
              </div>
            </div>

            {importResult.nodes.length > 0 && (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('proxyPool.name')}</TableHead>
                      <TableHead>{t('proxyPool.host')}</TableHead>
                      <TableHead>{t('proxyPool.port')}</TableHead>
                      <TableHead>{t('proxyPool.username')}</TableHead>
                      <TableHead>{t('proxyPool.location')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importResult.nodes.slice(0, 6).map((node, index) => (
                      <TableRow key={`${node.sourceLine}-${node.host}-${node.port}-${index}`}>
                        <TableCell>{node.name}</TableCell>
                        <TableCell>{node.host}</TableCell>
                        <TableCell>{node.port}</TableCell>
                        <TableCell>{node.username || '-'}</TableCell>
                        <TableCell>{formatLocation(node) || '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {importResult.nodes.length > 6 && (
                  <div className="border-t px-3 py-2 text-xs text-muted-foreground">
                    {t('proxyPool.morePreview', { count: importResult.nodes.length - 6 })}
                  </div>
                )}
              </div>
            )}

            {importResult.issues.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <div className="font-medium text-destructive">{t('proxyPool.importIssues')}</div>
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {importResult.issues.slice(0, 5).map((issue, index) => (
                    <div key={`${issue.line}-${issue.code}-${index}`}>
                      {issue.line > 0 ? `${t('proxyPool.line')} ${issue.line}: ` : ''}
                      {issue.message}
                    </div>
                  ))}
                  {importResult.issues.length > 5 && (
                    <div>{t('proxyPool.moreIssues', { count: importResult.issues.length - 5 })}</div>
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportDialogOpen(false)} disabled={isImporting}>
              {t('common.cancel')}
            </Button>
            <Button onClick={importNodes} disabled={isImporting || importResult.nodes.length === 0}>
              {isImporting ? t('proxyPool.importing') : t('proxyPool.importConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default ProxyPool
