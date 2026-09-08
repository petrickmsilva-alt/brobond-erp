# Sistema de Estorno de Movimentações de Estoque

## 📋 Problema Identificado

Quando uma movimentação (entrada, saída ou ajuste) era salva incorretamente no Estoque Físico, não havia forma de corrigir o lançamento. O sistema mantinha as movimentações como **imutáveis** por design (para preservar trilha de auditoria), mas isso impedia correções simples de erros de digitação.

**Impacto**: O saldo de estoque ficava incorreto e o usuário precisava criar manualmente um lançamento inverso, o que era confuso e propenso a erros.

---

## ✅ Solução Implementada

Foi criado um **sistema de estorno** que permite reverter movimentações de forma segura, mantendo a trilha de auditoria completa.

### 🔑 Funcionalidades Adicionadas

#### 1. **Botão de Estorno na Lista de Movimentações**
- Aparece apenas para movimentações que **ainda não foram estornadas**
- Disponível para usuários com perfil **gerente** ou **admin**
- Ícone de rotação (↻) em cor âmbar para fácil identificação
- Confirmação antes de executar o estorno

#### 2. **Histórico de Movimentações no Modal da Célula**
- Ao clicar em uma célula da grade de estoque, agora é exibido o **histórico das últimas 10 movimentações** daquele produto/tamanho
- Cada movimentação mostra: ID, data, tipo, quantidade, motivo e botão de estorno
- Movimentações já estornadas aparecem com **transparência reduzida** e badge "Estornado"
- Permite estornar diretamente da grade, sem precisar ir para a lista de movimentações

#### 3. **Indicação Visual de Movimentações Estornadas**
- Na lista de movimentações, registros estornados aparecem com **opacity reduzida** e **texto riscado**
- Badge "Estornado" substitui o tipo original
- Preserva o histórico para auditoria

#### 4. **Campos de Auditoria Adicionados**
- `estornado` (boolean): marca se a movimentação foi estornada
- `estornado_em` (datetime): data/hora do estorno
- `estornado_por` (text): nome do usuário que estornou
- `movimentacao_estorno_id` (ref): referência à movimentação inversa criada

---

## 🔧 Como Funciona o Estorno

### Processo Automático:

1. **Usuário clica em "Estornar"** na movimentação desejada
2. **Sistema exibe confirmação** explicando que será criado um lançamento inverso
3. **Ao confirmar**, o sistema:
   - Cria automaticamente uma **movimentação inversa** (entrada ↔ saída, ajuste inverte sinal)
   - **Ajusta o estoque** revertendo o efeito original
   - **Marca a movimentação original** como estornada (com data, hora e usuário)
   - **Registra na auditoria** para rastreabilidade completa
4. **Resultado**: Saldo correto + histórico preservado

### Exemplos:

#### Exemplo 1: Entrada errada
- **Original**: Entrada de 10 peças
- **Estorno**: Cria saída de 10 peças
- **Resultado**: Saldo volta ao valor anterior

#### Exemplo 2: Saída errada
- **Original**: Saída de 5 peças
- **Estorno**: Cria entrada de 5 peças
- **Resultado**: Saldo volta ao valor anterior

#### Exemplo 3: Ajuste com valor errado
- **Original**: Ajuste de +20 peças
- **Estorno**: Cria ajuste de -20 peças
- **Resultado**: Saldo volta ao valor anterior

#### Exemplo 4: Transferência para local errado
- **Original**: Transferência de 15 peças da Loja → Expedição
- **Estorno**: Cria transferência de 15 peças da Expedição → Loja
- **Resultado**: Peças voltam ao local original

---

## 🎯 Onde Encontrar

### Na Grade de Estoque (`/estoque`):
1. Clique em qualquer célula da matriz
2. O modal abrirá com o formulário de lançamento
3. **Abaixo do formulário**, veja o histórico das últimas movimentações
4. Clique em **"Estornar"** na linha desejada
5. Confirme a ação

### Na Lista de Movimentações (`/movimentacoes`):
1. Localize a movimentação que deseja estornar
2. Clique no **ícone de rotação (↻)** na coluna de ações
3. Confirme a ação
4. A linha ficará com transparência e texto riscado

---

## 🔒 Segurança e Auditoria

### Restrições:
- Apenas **gerentes e administradores** podem estornar movimentações
- Movimentações **já estornadas não podem ser estornadas novamente**
- O sistema **não permite excluir** movimentações (apenas estornar)

### Auditoria:
- Toda movimentação estornada é registrada no log de auditoria
- Campos `estornado_em` e `estornado_por` identificam quem e quando estornou
- A movimentação original permanece no histórico (não é deletada)
- A movimentação de estorno referencia a original via `movimentacao_estorno_id`

---

## 📝 Arquivos Modificados

### Backend (`server/src/`):
- `resources.ts`: Adicionados campos de estorno ao recurso movimentações
- `estoque.ts`: Função `estornarMovimentacao()` implementada
- `index.ts`: Rota `POST /api/movimentacoes/:id/estornar` registrada

### Frontend (`client/src/pages/`):
- `ModulePage.tsx`: Botão de estorno na lista de movimentações + modal de confirmação
- `EstoqueGradePage.tsx`: Histórico de movimentações no modal da célula + botão de estorno

---

## 💡 Boas Práticas

1. **Sempre confirme os dados** antes de salvar uma movimentação
2. **Use motivos descritivos** para facilitar a identificação posterior
3. **Estorne o mais rápido possível** após identificar o erro
4. **Comunique a equipe** quando estornar movimentações de outros usuários
5. **Revise o histórico** periodicamente para identificar padrões de erro

---

## 🚀 Próximas Evoluções Sugeridas

1. **Limite de tempo para estorno**: Permitir estorno apenas nas últimas 24h ou 7 dias
2. **Notificações**: Alertar responsáveis quando movimentações forem estornadas
3. **Relatório de estornos**: Dashboard com movimentações mais estornadas (identifica treinamento necessário)
4. **Estorno em lote**: Selecionar múltiplas movimentações para estornar de uma vez
5. **Motivo obrigatório no estorno**: Campo para explicar por que está estornando

---

## ❓ Perguntas Frequentes

**P: Posso excluir uma movimentação?**  
R: Não. Movimentações são imutáveis para preservar a trilha de auditoria. Use o estorno.

**P: O estorno cria uma nova movimentação?**  
R: Sim. Uma movimentação inversa é criada automaticamente e vinculada à original.

**P: O saldo é ajustado automaticamente?**  
R: Sim. O estoque é recalculado imediatamente após o estorno.

**P: Outros usuários veem que estornei?**  
R: Sim. O campo `estornado_por` mostra quem estornou e `estornado_em` mostra quando.

**P: Posso estornar uma movimentação que já foi estornada?**  
R: Não. O sistema bloqueia estorno duplicado para evitar inconsistências.

**P: Transferências também podem ser estornadas?**  
R: Sim. O estorno inverte a transferência (volta as peças para o local original).

---

## 📞 Suporte

Em caso de dúvidas ou problemas, consulte o log de auditoria em `/auditoria` para ver todas as ações de estorno realizadas.
