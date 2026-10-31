// Campo JSON (coluna JSONB) no formulário genérico — contrato com o servidor.
//
// As Ondas 4–5 expuseram recursos PÚBLICOS com campos `json` (regra de
// segmento, condição de automação, evidência de recomendação, premissas de
// cenário). Sem um editor real, o campo caía no input de texto e o payload
// levava `"[object Object]"` — ou o valor do banco voltava como objeto e o
// React renderizava lixo. Este teste fixa o contrato:
//   • o valor do banco (objeto) vira TEXTO JSON indentado no editor;
//   • JSON inválido é barrado ANTES de sair para a API (validarFormulario);
//   • JSON válido vira OBJETO no payload (toPayload) — o store serializa;
//   • campo vazio vira `null` (o servidor aceita).
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RecordForm, initialValues, toPayload, validarFormulario } from './RecordForm';
import type { ResourceMeta } from '../lib/meta';

const recurso: ResourceMeta = {
  key: 'customer_segments',
  label: 'Segmentos',
  singular: 'Segmento',
  labelFields: ['nome'],
  ops: { create: true, update: true, delete: true },
  fields: [
    { name: 'nome', label: 'Nome', type: 'text', required: true },
    { name: 'regra', label: 'Regra (JSON)', type: 'json', form: true, list: false },
  ],
};

describe('RecordForm — campo JSON', () => {
  it('mostra o objeto vindo do banco como JSON indentado (não "[object Object]")', () => {
    const row = { id: 1, nome: 'VIP', regra: { valor_min: 500, consentimento_marketing: true } };
    const values = initialValues(recurso, row);
    expect(values.regra).toBe('{\n  "valor_min": 500,\n  "consentimento_marketing": true\n}');
    expect(values.regra).not.toContain('[object Object]');
  });

  it('renderiza o editor de JSON e propaga a edição', () => {
    let values = initialValues(recurso, { id: 1, nome: 'VIP', regra: '{"a":1}' });
    const onChange = (_n: string, v: string | boolean | string[]) => {
      values = { ...values, _last: String(v) } as any;
    };
    render(
      <RecordForm
        resource={recurso}
        values={values}
        errors={{}}
        onChange={onChange}
        onSubmit={() => {}}
        onClear={() => {}}
        editing
        busy={false}
        refOptions={{}}
      />
    );
    const editor = screen.getByLabelText(/Regra \(JSON\)/) as HTMLTextAreaElement;
    expect(editor.tagName).toBe('TEXTAREA');
    expect(editor.value).toBe('{"a":1}');
    fireEvent.change(editor, { target: { value: '{"b":2}' } });
    expect((values as any)._last).toBe('{"b":2}');
  });

  it('recusa JSON inválido antes de chamar a API', () => {
    const { errors } = validarFormulario(recurso, { nome: 'VIP', regra: '{nao-json}' }, true);
    expect(errors.regra).toMatch(/JSON inválido/);
  });

  it('leva o OBJETO parseado no payload e vazio como null', () => {
    const ok = toPayload(recurso, { nome: 'VIP', regra: '{"valor_min":500}' }, true);
    expect(ok.regra).toEqual({ valor_min: 500 });
    const vazio = toPayload(recurso, { nome: 'VIP', regra: '' }, true);
    expect(vazio.regra).toBeNull();
  });
});
