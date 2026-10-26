// ============================================================================
// CADASTRO EM DRAWER LATERAL (padrão dos cadastros simples)
//
// Substitui o modal central nos cadastros simples: quem cadastra continua
// vendo a lista ao fundo, com contexto. O formulário NÃO é reimplementado —
// continua sendo o `RecordForm` dirigido pelos metadados do recurso
// (`GET /api/meta`), com as mesmas validações, os mesmos campos e o mesmo
// contrato de API. Este componente só troca a SUPERFÍCIE e organiza:
//
//   • cabeçalho: título + descrição de apoio;
//   • corpo: alerta de erro, prévia em tempo real dos campos de cor e o form;
//   • rodapé FIXO: [Cancelar] [Salvar] — a única barra de ações da tela.
//
// É reutilizável: qualquer recurso que declare `editor: 'drawer'` no metadado
// ganha a experiência (Categorias, Tamanhos, Grades, Coleções... podem adotar
// depois sem novo componente e sem nova tela).
// ============================================================================
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Field, Option, ResourceMeta } from '../lib/meta';
import { erroHex, normalizarHex } from '../lib/hex';
import { Alert } from './ui';
import { Drawer } from './ui-kit-negocios';
import { AmostraCor } from './AmostraCor';
import { RecordForm, type FormValues } from './RecordForm';

/** Prévia ao vivo de um campo de cor (`type: 'color'` do metadado). */
function PreviaCor({
  field,
  valor,
  nome,
}: {
  field: Field;
  valor: string;
  nome: string;
}) {
  const hex = normalizarHex(valor);
  const erro = hex ? erroHex(hex) : null;
  return (
    <section className="rounded-xl border border-line bg-surface p-3" aria-label={`Prévia de ${field.label}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Amostra visual</h3>
        <span className="font-mono text-xs text-ink">{hex || 'Sem código HEX'}</span>
      </div>
      <AmostraCor hex={hex} nome={nome || null} tamanho="lg" className="mt-2" />
      {erro ? (
        <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400" role="alert">
          {erro}
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted">
          {hex ? 'A amostra acompanha o código enquanto você digita.' : 'Opcional — sem o código, a cor aparece sem amostra nas listas.'}
        </p>
      )}
    </section>
  );
}

export function CadastroDrawer({
  open,
  onClose,
  resource,
  editing,
  title,
  description,
  values,
  errors,
  formError,
  onChange,
  onSubmit,
  busy,
  refOptions,
  submitLabel,
  cancelLabel = 'Cancelar',
  before,
}: {
  open: boolean;
  onClose: () => void;
  resource: ResourceMeta;
  editing: boolean;
  title: string;
  description?: string;
  values: FormValues;
  errors: Record<string, string>;
  formError?: string;
  onChange: (name: string, value: string | boolean | string[]) => void;
  onSubmit: () => void;
  busy: boolean;
  refOptions: Record<string, Option[]>;
  submitLabel: string;
  cancelLabel?: string;
  before?: ReactNode;
}) {
  const camposCor = resource.fields.filter((f) => f.form !== false && !f.readonly && f.type === 'color');
  const nomeRegistro = String(values[resource.labelFields[0]] ?? '').trim();
  // A prévia entra logo DEPOIS do campo de cor — o usuário digita o HEX e vê a
  // amostra mudar no mesmo lugar, sem sair do formulário.
  const depoisDoCampo: Record<string, ReactNode> = {};
  for (const f of camposCor) {
    depoisDoCampo[f.name] = <PreviaCor field={f} valor={String(values[f.name] ?? '')} nome={nomeRegistro} />;
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          {/* Botão fora do <form>: usa o atributo `form` para submeter o mesmo
              formulário do corpo — Enter continua salvando, sem duplicar a
              barra de ações dentro do drawer. */}
          <button type="submit" form={`form-${resource.key}`} className="btn-accent" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {submitLabel}
          </button>
        </>
      }
    >
      {formError && (
        <div className="mb-4">
          <Alert tone="red">{formError}</Alert>
        </div>
      )}
      {before}
      <RecordForm
        resource={resource}
        values={values}
        errors={errors}
        onChange={onChange}
        onSubmit={onSubmit}
        onClear={() => {}}
        editing={editing}
        busy={busy}
        refOptions={refOptions}
        autoFocus
        layout="unico"
        hideActions
        depoisDoCampo={depoisDoCampo}
      />
    </Drawer>
  );
}
