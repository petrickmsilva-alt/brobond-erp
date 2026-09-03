import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Inbox, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeta, type Field, type ListResult, type ResourceMeta } from '../lib/meta';
import { formatCell } from '../lib/format';
import type { Module } from '../modules';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, ConfirmDialog, EmptyState, Modal, PageHeader, Spinner, useToast } from '../components/ui';
import { fieldErrors, initialValues, RecordForm, toPayload, useRefOptions, type FormValues } from '../components/RecordForm';
import PlannedModule from './PlannedModule';

const PAGE_SIZE = 25;

export default function ModulePage({ module }: { module: Module }) {
  const meta = useMeta();
  const resource = module.resource ? meta.resources[module.resource] : undefined;

  if (!module.resource || !resource) return <PlannedModule module={module} />;
  return <ResourceCrud key={resource.key} module={module} resource={resource} />;
}

// ----------------------------------------------------------------------------
// CRUD genérico de um recurso
// ----------------------------------------------------------------------------
function ResourceCrud({ module, resource }: { module: Module; resource: ResourceMeta }) {
  const { user } = useAuth();
  const toast = useToast();
  const isOperador = user?.perfil === 'operador';
  const canCreate = resource.ops.create;
  const canUpdate = resource.ops.update;
  const canDelete = resource.ops.delete && !isOperador;
  const readOnly = !canCreate && !canUpdate && !canDelete;

  // Lista
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | null>(null);

  // Formulário (modal)
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const [values, setValues] = useState<FormValues>(() => initialValues(resource));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [optionsKey, setOptionsKey] = useState(0);
  const refOptions = useRefOptions(resource, optionsKey);

  // Exclusão
  const [toDelete, setToDelete] = useState<Record<string, any> | null>(null);
  const [deleting, setDeleting] = useState(false);

  const listFields = useMemo(() => resource.fields.filter((f) => f.list !== false && !f.virtual && f.type !== 'password'), [resource]);
  const searchable = resource.fields.some((f) => f.search);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedQ(q.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (debouncedQ) params.set('q', debouncedQ);
      if (sort) {
        params.set('sort', sort.field);
        params.set('dir', sort.dir);
      }
      const d = await api.get<ListResult>(`/${resource.key}?${params.toString()}`);
      setData(d);
      if (d.total > 0 && d.rows.length === 0 && page > 1) setPage(Math.max(1, Math.ceil(d.total / PAGE_SIZE)));
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [resource.key, page, debouncedQ, sort]);

  useEffect(() => {
    load();
  }, [load]);

  // --- formulário ---
  function openCreate() {
    setEditing(null);
    setValues(initialValues(resource));
    setErrors({});
    setFormError('');
    setOptionsKey((k) => k + 1);
    setFormOpen(true);
  }

  function openEdit(row: Record<string, any>) {
    setEditing(row);
    setValues(initialValues(resource, row));
    setErrors({});
    setFormError('');
    setOptionsKey((k) => k + 1);
    setFormOpen(true);
  }

  function clearForm() {
    setValues(initialValues(resource, null));
    setErrors({});
    setFormError('');
  }

  function closeForm() {
    if (saving) return;
    setFormOpen(false);
  }

  function onChange(name: string, value: string | boolean) {
    setValues((v) => ({ ...v, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: '' }));
  }

  /** Validação local rápida (obrigatórios) antes de chamar a API. */
  function validateLocal(): boolean {
    const errs: Record<string, string> = {};
    for (const f of resource.fields) {
      if (f.form === false || f.readonly) continue;
      const required = f.required || (!editing && f.requiredOnCreate);
      const v = values[f.name];
      if (required && f.type !== 'boolean' && (v === undefined || String(v).trim() === '')) errs[f.name] = 'Campo obrigatório';
      if (f.type === 'password' && typeof v === 'string' && v && f.min && v.length < f.min) errs[f.name] = `Mínimo de ${f.min} caracteres`;
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Preencha os campos obrigatórios destacados.');
      return false;
    }
    return true;
  }

  async function submit() {
    setFormError('');
    if (!validateLocal()) return;
    setSaving(true);
    try {
      const payload = toPayload(resource, values, !!editing);
      if (editing) {
        await api.put(`/${resource.key}/${editing.id}`, payload);
        toast.success(`${resource.singular} salvo(a) com sucesso.`);
        setFormOpen(false);
      } else {
        await api.post(`/${resource.key}`, payload);
        toast.success(`${resource.singular} incluído(a) com sucesso.`);
        // Mantém o formulário aberto e limpo para o próximo cadastro
        setValues(initialValues(resource));
        setErrors({});
        document.getElementById(`form-${resource.key}`)?.querySelector<HTMLElement>('input, select, textarea')?.focus();
      }
      await load();
    } catch (e: any) {
      const fe = fieldErrors(e);
      setErrors(fe);
      setFormError(e instanceof ApiError ? e.message : 'Não foi possível salvar. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.del(`/${resource.key}/${toDelete.id}`);
      toast.success(`${resource.singular} excluído(a).`);
      setToDelete(null);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível excluir.');
    } finally {
      setDeleting(false);
    }
  }

  function toggleSort(f: Field) {
    if (f.virtual) return;
    setSort((s) => (s?.field === f.name ? (s.dir === 'asc' ? { field: f.name, dir: 'desc' } : null) : { field: f.name, dir: 'asc' }));
    setPage(1);
  }

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(total, page * PAGE_SIZE);
  const Icon = module.icon;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Icon className="h-5 w-5" />
            </span>
            {module.label}
          </span>
        }
        description={module.description}
        actions={
          <>
            <button className="btn-secondary" onClick={load} disabled={loading} title="Atualizar lista">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
            {canCreate && (
              <button className="btn-accent" onClick={openCreate}>
                <Plus className="h-4 w-4" /> Novo {resource.singular.toLowerCase()}
              </button>
            )}
          </>
        }
      />

      {resource.notice && (
        <div className="mb-4">
          <Alert tone={readOnly ? 'slate' : 'blue'}>{resource.notice}</Alert>
        </div>
      )}

      <div className="card overflow-hidden">
        {/* Barra de ferramentas */}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
          {searchable && (
            <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input className="input pl-9 pr-8" placeholder={`Buscar em ${module.label.toLowerCase()}...`} value={q} onChange={(e) => setQ(e.target.value)} />
              {q && (
                <button className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => setQ('')} aria-label="Limpar busca">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          <div className="ml-auto text-xs text-slate-500">
            {loading && !data ? 'Carregando...' : total === 0 ? 'Nenhum registro' : `${from}–${to} de ${total} registro${total === 1 ? '' : 's'}`}
          </div>
        </div>

        {error && (
          <div className="p-4">
            <Alert tone="red">{error}</Alert>
          </div>
        )}

        {!error && loading && !data && <Spinner />}

        {!error && data && data.rows.length === 0 && (
          <EmptyState
            icon={<Inbox className="h-6 w-6" />}
            title={debouncedQ ? 'Nada encontrado' : `Nenhum(a) ${resource.singular.toLowerCase()} cadastrado(a)`}
            description={debouncedQ ? `Nenhum resultado para "${debouncedQ}".` : canCreate ? `Clique em "Novo ${resource.singular.toLowerCase()}" para fazer o primeiro cadastro.` : undefined}
            action={
              debouncedQ ? (
                <button className="btn-secondary" onClick={() => setQ('')}>
                  Limpar busca
                </button>
              ) : canCreate ? (
                <button className="btn-accent" onClick={openCreate}>
                  <Plus className="h-4 w-4" /> Novo {resource.singular.toLowerCase()}
                </button>
              ) : undefined
            }
          />
        )}

        {!error && data && data.rows.length > 0 && (
          <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
            <table className="table">
              <thead>
                <tr>
                  <th className="w-16">#</th>
                  {listFields.map((f) => (
                    <th key={f.name}>
                      <button className="inline-flex items-center gap-1 hover:text-navy-800" onClick={() => toggleSort(f)}>
                        {f.label}
                        {sort?.field === f.name ? sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-30" />}
                      </button>
                    </th>
                  ))}
                  {(canUpdate || canDelete) && <th className="w-24 text-right">Ações</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id} className={canUpdate ? 'cursor-pointer' : ''} onDoubleClick={() => canUpdate && openEdit(row)}>
                    <td className="font-mono text-xs text-slate-400">{row.id}</td>
                    {listFields.map((f) => (
                      <td key={f.name} className={f.type === 'money' || f.type === 'number' || f.type === 'integer' || f.type === 'percent' ? 'text-right tabular-nums' : ''}>
                        <Cell f={f} row={row} />
                      </td>
                    ))}
                    {(canUpdate || canDelete) && (
                      <td className="text-right">
                        <div className="inline-flex items-center gap-1">
                          {canUpdate && (
                            <button className="btn-icon" onClick={() => openEdit(row)} title="Editar" aria-label="Editar">
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                          {canDelete && (
                            <button className="btn-icon hover:!bg-red-50 hover:!text-red-600" onClick={() => setToDelete(row)} title="Excluir" aria-label="Excluir">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Paginação */}
        {data && total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2.5 text-sm">
            <span className="text-slate-500">
              Página {page} de {pages}
            </span>
            <div className="flex items-center gap-1">
              <button className="btn-icon" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} aria-label="Página anterior">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button className="btn-icon" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)} aria-label="Próxima página">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modal de cadastro / edição */}
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={editing ? `Editar ${resource.singular.toLowerCase()}` : `Novo ${resource.singular.toLowerCase()}`}
        subtitle={editing ? `Registro #${editing.id}` : `Preencha os dados e clique em Incluir. Os campos com * são obrigatórios.`}
        size={resource.fields.filter((f) => f.form !== false && !f.readonly).length > 6 ? 'lg' : 'md'}
      >
        {formError && (
          <div className="mb-4">
            <Alert tone="red">{formError}</Alert>
          </div>
        )}
        <RecordForm
          resource={resource}
          values={values}
          errors={errors}
          onChange={onChange}
          onSubmit={submit}
          onClear={clearForm}
          editing={!!editing}
          busy={saving}
          refOptions={refOptions}
        />
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        title={`Excluir ${resource.singular.toLowerCase()}?`}
        danger
        confirmLabel="Excluir"
        busy={deleting}
        onCancel={() => !deleting && setToDelete(null)}
        onConfirm={confirmDelete}
        message={
          <>
            <p>
              Você está prestes a excluir <strong>{toDelete ? rowLabel(resource, toDelete) : ''}</strong>. Esta ação não pode ser desfeita.
            </p>
            {resource.fields.some((f) => f.name === 'ativo') && <p className="mt-2 text-slate-500">Dica: se o registro já foi usado em outro módulo, prefira desmarcar "Ativo" ao editá-lo.</p>}
          </>
        }
      />
    </div>
  );
}

function rowLabel(r: ResourceMeta, row: Record<string, any>): string {
  const parts = r.labelFields.map((f) => row[f]).filter((v) => v !== null && v !== undefined && String(v) !== '');
  if (r.labelFields.length === 1 && r.labelFields[0] === 'id') return `#${row.id}`;
  return parts.length ? parts.join(' — ') : `#${row.id}`;
}

function Cell({ f, row }: { f: Field; row: Record<string, any> }) {
  const v = row[f.name];
  if (f.type === 'boolean') {
    return v ? <Badge tone="green">Sim</Badge> : <Badge tone="slate">Não</Badge>;
  }
  if (f.type === 'select' && f.options) {
    const opt = f.options.find((o) => o.value === String(v));
    if (opt?.tone) return <Badge tone={opt.tone}>{opt.label}</Badge>;
    return <>{opt?.label ?? (v ?? '—')}</>;
  }
  const text = formatCell(f, row);
  if (f.type === 'ref' && text !== '—') return <span className="font-medium text-slate-800">{text}</span>;
  if (text === '—') return <span className="text-slate-300">—</span>;
  return <span className={f.type === 'text' && f.name === 'nome' ? 'font-medium text-slate-800' : ''}>{text}</span>;
}
