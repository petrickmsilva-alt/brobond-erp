/**
 * Superfície pública do conector do Instagram Shopping.
 *
 * O módulo é AUTOCONTIDO: quem consome o Instagram (as rotas do ERP, o
 * agendador, os testes) importa daqui e de mais lugar nenhum. Nenhum
 * arquivo desta pasta importa outro canal, e nenhum outro canal importa
 * esta pasta.
 */

export * from './instagram.service';
export * from './instagram.connector';
export * from './instagram.connector.service';
