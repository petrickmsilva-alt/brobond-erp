import { beforeEach, describe, expect, it } from 'vitest';
import { adicionarAoCarrinho, alterarQuantidade, definirCupom, lerCarrinho, limparCarrinho, removerDoCarrinho } from './carinho';

beforeEach(() => limparCarrinho());

describe('Carrinho — snapshot imutável, cupom persistido e chave de retry', () => {
  it('adicionar novamente o mesmo SKU notifica React com nova referência sem alterar snapshot anterior', () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    const antes = lerCarrinho();
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 2 });
    expect(lerCarrinho()).not.toBe(antes);
    expect(antes.itens[0].quantidade).toBe(1);
    expect(lerCarrinho().itens[0].quantidade).toBe(3);
    expect(lerCarrinho().chave).not.toBe(antes.chave);
  });

  it('a mesma intenção mantém a chave; modificar quantidade/cupom cria outra intenção', () => {
    adicionarAoCarrinho({ produto_id: 7, tamanho_id: null, quantidade: 1 });
    const primeira = lerCarrinho().chave;
    expect(lerCarrinho().chave).toBe(primeira);
    alterarQuantidade(7, null, 2);
    const segunda = lerCarrinho().chave;
    expect(segunda).not.toBe(primeira);
    definirCupom(' cupom-real ');
    expect(lerCarrinho().chave).not.toBe(segunda);
    expect(lerCarrinho().cupom).toBe('CUPOM-REAL');
    const comCupom = lerCarrinho();
    definirCupom('CUPOM-REAL');
    expect(lerCarrinho()).toBe(comCupom);
    expect(JSON.parse(localStorage.getItem('brobond-loja-carrinho')!).cupom).toBe('CUPOM-REAL');
    removerDoCarrinho(7, null);
    expect(lerCarrinho().chave).not.toBe(comCupom.chave);
  });
});
