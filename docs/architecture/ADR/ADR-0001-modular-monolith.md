# ADR-0001 — Arquitetura Modular Monolith

* **Identificador:** ADR-0001
* **Título:** Arquitetura Modular Monolith
* **Status:** Aceita
* **Data:** 2026-11-07
* **Relacionados:** ADR-0002 (fronteiras), ADR-0014 (Prisma×SQL)

## Contexto

O BROBOND ERP é um sistema único (web + cron) com ~254 mil linhas de TypeScript,
domínios bem delimitados e bounded contexts desacoplados em `modules/`
(payments, logistics, connectors). Já opera em produção com multiempresa e
multi-loja.

## Problema

Decidir a forma arquitetural oficial — microserviços, monolito tradicional ou
monólito modular — considerando que o ERP está **em operação** e não pode ser
reescrito.

## Decisão

Adotar **Modular Monolith**: um sistema integrado, com domínios delimitados,
responsabilidades separadas, contratos explícitos entre módulos, dependências
controladas, eventos de domínio quando apropriados, outbox/inbox para
integração confiável, isolamento por empresa/contexto comercial, testes de
integração entre domínios e possibilidade de extração futura sem reescrita.

**Não** criar microserviços nesta missão.

## Alternativas consideradas

- **Microserviços:** rejeitada. Sem requisito comprovado de escala,
  disponibilidade, isolamento ou operação que justifique o custo operacional e
  a fragmentação de transações.
- **Monolito tradicional (big ball of mud):** rejeitada. Perderia as fronteiras
  já existentes e a possibilidade de extração.
- **Reescrever em outra stack:** rejeitada. Viola "não reescrever o ERP".

## Consequências

- Transações locais permanecem simples (sem transação distribuída artificial).
- Extração futura de um contexto é possível por contrato, não por reescrita.
- Exige disciplina de fronteira (ADR-0002): proibido acessar tabela interna de
  outro contexto.

## Riscos

- Erosão de fronteiras ao longo do tempo → mitigada por `DEPENDENCY-MAP.md` e
  pelos gates de arquitetura.
