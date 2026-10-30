-- A matched provider/bank pair is not financial proof without the original
-- revenue and its individually posted reversals in the canonical book.
CREATE OR REPLACE FUNCTION fin_repasse_comprovado(p_empresa INTEGER, p_repasse BIGINT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
SELECT EXISTS (
 SELECT 1 FROM payment_payouts p
 JOIN fin_extrato_transacoes e ON e.empresa_id=p.empresa_id AND e.id=p.bank_transaction_id
 JOIN payment_settlements s ON s.empresa_id=p.empresa_id AND s.payout_id=p.id
 LEFT JOIN payment_intents i ON i.empresa_id=s.empresa_id AND i.id=s.payment_intent_id
 LEFT JOIN gateway_cobrancas g ON g.empresa_id=i.empresa_id AND g.id=i.cobranca_id
 LEFT JOIN commerce_pedidos o ON o.empresa_id=i.empresa_id AND o.id=i.order_id
 LEFT JOIN lancamentos_financeiros l ON l.empresa_id=g.empresa_id AND l.id=g.lancamento_id
 WHERE p.empresa_id=p_empresa AND p.id=p_repasse AND p.status='MATCHED'
 GROUP BY p.id,e.id
 HAVING sum(s.net_amount)=p.net_amount AND round(e.valor*100)=p.net_amount
 AND e.direcao='entrada' AND e.status='importada' AND e.data IS NOT NULL AND e.conta_id IS NOT NULL
 AND bool_and(coalesce(
   s.status='MATCHED' AND NOT s.dispute_review_required AND s.gross_amount=i.amount
   AND s.net_amount=s.gross_amount-s.provider_fee-s.gateway_fee-s.installment_fee-s.antifraud_fee-s.refund_amount-s.chargeback_amount
   AND g.venda_id=o.venda_id AND l.referencia_tipo='venda' AND l.referencia_id=o.venda_id
   AND l.tipo='receita' AND l.status='confirmado' AND round(l.valor*100)=i.amount
   AND round(l.valor_liquido*100)=s.gross_amount-s.provider_fee-s.gateway_fee-s.installment_fee-s.antifraud_fee
   AND l.conta_id=e.conta_id AND l.data_baixa=e.data
   AND s.refund_amount=coalesce((SELECT round(sum(r.valor)*100) FROM lancamentos_financeiros r
       WHERE r.empresa_id=p_empresa AND r.referencia_tipo='estorno' AND r.referencia_id=l.id AND r.status='confirmado' AND r.conta_id=e.conta_id AND r.data_baixa=e.data),0)
   AND s.chargeback_amount=coalesce((SELECT round(sum(r.valor)*100) FROM payment_disputes d
       JOIN lancamentos_financeiros r ON r.empresa_id=d.empresa_id AND r.referencia_tipo='chargeback_dispute' AND r.referencia_id=d.id AND r.status='confirmado' AND r.conta_id=e.conta_id AND r.data_baixa=e.data
       WHERE d.empresa_id=p_empresa AND d.payment_intent_id=i.id),0),false))
);
$$;
