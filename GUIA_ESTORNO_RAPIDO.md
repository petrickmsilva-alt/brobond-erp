# 🔄 Guia Rápido: Estorno de Movimentações

## 🎯 Quando Usar?

- ❌ **Salvou uma movimentação com quantidade errada?**
- ❌ **Escolheu o tipo errado (entrada ao invés de saída)?**
- ❌ **Lançou no produto/tamanho errado?**

**Solução**: Use o **ESTORNO** para reverter automaticamente!

---

## 📍 Como Estornar (2 formas)

### **Opção 1: Pela Grade de Estoque** ⭐ Mais Fácil

```
1. Acesse: Estoque Físico → Grade
2. Clique na célula do produto/tamanho
3. Veja o histórico das últimas movimentações (abaixo do formulário)
4. Clique em "Estornar" na linha desejada
5. Confirme a ação
```

**Vantagem**: Você vê o saldo atual e o histórico no mesmo lugar!

---

### **Opção 2: Pela Lista de Movimentações**

```
1. Acesse: Estoque → Movimentações
2. Localize a movimentação errada
3. Clique no ícone ↻ (rotação) na coluna de ações
4. Confirme a ação
```

**Vantagem**: Veja todas as movimentações de uma vez e use filtros!

---

## ✅ O que acontece após estornar?

| Antes | Depois |
|-------|--------|
| Entrada de 10 peças | Saída de 10 peças criada automaticamente |
| Saída de 5 peças | Entrada de 5 peças criada automaticamente |
| Ajuste de +20 peças | Ajuste de -20 peças criado automaticamente |
| Transferência A→B | Transferência B→A criada automaticamente |

**Resultado**: O saldo volta ao valor correto! ✨

---

## 🔍 Como identificar movimentações estornadas?

### Na lista de movimentações:
- ✅ Linha com **transparência reduzida** (50%)
- ✅ Texto **riscado** (~~tachado~~)
- ✅ Badge cinza escrito **"Estornado"**

### No histórico da célula:
- ✅ Badge **"Estornado"** na coluna de tipo
- ✅ Linha com **transparência reduzida**
- ✅ Botão "Estornar" **desaparece** (não pode estornar duas vezes)

---

## ⚠️ Importante

### ✅ **PODE** estornar:
- Movimentações recentes (qualquer data)
- Entradas, saídas, ajustes e transferências
- Movimentações criadas por qualquer usuário

### ❌ **NÃO PODE** estornar:
- Movimentações já estornadas (só uma vez!)
- Se você não for gerente ou administrador

---

## 💡 Dicas de Ouro

1. **Estorne rápido**: Quanto antes estornar, menos confusão no histórico
2. **Confira o saldo**: Após estornar, verifique se o saldo ficou correto
3. **Use motivos claros**: Ao lançar, escreva motivos descritivos (facilita identificar depois)
4. **Revise antes de salvar**: Confira produto, tamanho, quantidade e tipo antes de lançar
5. **Comunique a equipe**: Se estornou movimentação de outro usuário, avise!

---

## 🎬 Exemplo Prático

### Cenário: Você lançou entrada de 100 peças, mas eram só 10

**Passo a passo**:

1. Vá em **Estoque → Grade**
2. Clique na célula do produto
3. No histórico, encontre a movimentação "Entrada · 100 peças"
4. Clique em **"Estornar"**
5. Confirme

**Resultado**:
- ✅ Sistema cria **saída de 100 peças** automaticamente
- ✅ Saldo volta ao valor anterior
- ✅ Agora você pode lançar a **entrada correta de 10 peças**

---

## 🆘 Problemas?

### "Não aparece o botão de estorno"
- Verifique se você é **gerente** ou **admin**
- A movimentação já pode ter sido estornada (verifique o badge)

### "Estornou mas o saldo não mudou"
- Atualize a página (F5)
- Verifique se está olhando o local correto

### "Estornei a movimentação errada"
- Sem problema! Faça um **novo lançamento** manual para corrigir
- Ou estorne a movimentação de estorno (crie uma nova e estorne)

---

## 📞 Suporte

Dúvidas? Consulte o log de auditoria em `/auditoria` para ver todas as ações de estorno realizadas.

---

**Lembre-se**: O estorno é sua rede de segurança! Use sem medo quando precisar corrigir erros. 🛡️
