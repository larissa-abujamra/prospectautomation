import { describe, it, expect, vi } from 'vitest'
import {
  canSyncToHubspot,
  leadToContactProperties,
  leadToContactPropertiesWithTrigger,
  canExportDeal,
  hubspotDedupValue,
  leadToDealProperties,
  HUBSPOT_DEDUP_PROPERTY,
  HUBSPOT_OUTREACH_PROPERTY,
  HUBSPOT_OUTREACH_READY,
  HUBSPOT_WHATSAPP_PHONE_PROPERTY,
  HUBSPOT_DEALS_PIPELINE,
  HUBSPOT_OLIVIA_REPORTING_PROPERTIES,
  HUBSPOT_STAGE_PROSPECTS,
  HUBSPOT_STAGE_LOCALIZAR_RESPONSAVEL,
  HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO,
  HUBSPOT_STAGE_REUNIAO_PROPOSTA,
  HUBSPOT_STAGE_REUNIAO_AGENDADA,
  HUBSPOT_STAGE_CLOSED_WON,
  HUBSPOT_DEAL_STAGE_IDS,
  HUBSPOT_SETOR_GRUPO_PROPERTY,
  hubspotDealStageId,
  buildDealStagePatchBody,
  buildContactToDealAssociationBody,
  buildResponsibleContactPatchBody,
  buildResponsibleContactSearchBody,
  buildResponsibleContactWriteBody,
  buildOliviaReportingPatchBody,
  hubspotReplyContactCandidates,
  leadToOliviaReportingProperties,
  patchHubspotReplyOutreach,
  responsibleContactProperties,
  reusableResponsibleContactId,
  shouldSyncDealStage,
  highestKnownDealStage,
  shouldRestoreDealStage,
  hubspotDateSP,
  horaReuniaoLabel,
} from '../../../supabase/functions/_shared/hubspot'
import type { Lead } from '../types'

// Lead mínimo "sincronizável": número achado + place_id (chave de dedup).
function baseLead(over: Partial<Lead> = {}): Lead {
  return {
    id: 'uuid-1',
    nome: 'Pietra Pâtisserie',
    setor: 'Confeitaria',
    endereco: 'R. José da Silva Ribeiro, 616',
    bairro: 'Vila Andrade',
    cidade: 'São Paulo',
    lat: null,
    lng: null,
    google_place_id: 'ChIJ_place_123',
    squad_leads_id: null,
    origem: 'google_places',
    telefone: '(11) 96336-6136',
    website: 'http://www.instagram.com/pietrapatisserie',
    rating: 4.9,
    reviews_count: 69,
    instagram_handle: 'pietrapatisserie',
    instagram_followers: 7106,
    cnpj: null,
    razao_social: null,
    socios: null,
    dono_nome: null,
    enrich_status: null,
    whatsapp_phone: '+5511963366136',
    whatsapp_source: 'google',
    whatsapp_status: 'found',
    nome_genero: 'f',
    hubspot_contact_id: null,
    hubspot_synced_at: null,
    whatsapp_send_status: null,
    whatsapp_sent_at: null,
    whatsapp_msg_id: null,
    olivia_estado: null,
    olivia_handoff_motivo: null,
    reuniao_at: null,
    reuniao_link: null,
    whatsapp_dono: null,
    porte: null,
    mei: null,
    hubspot_deal_id: null,
    hubspot_responsavel_contact_id: null,
    bio_ponto_fisico: false,
    bio_linktree: false,
    bio_whatsapp_vendas: false,
    bio_delivery_proprio: false,
    lead_score: null,
    cliente_oculto_at: null,
    cliente_oculto_notas: null,
    inbound_score: null,
    inbound_classification: null,
    inbound_revenue_range: null,
    inbound_ready_to_implement: null,
    inbound_created_at: null,
    inbound_utm_source: null,
    inbound_utm_medium: null,
    inbound_utm_campaign: null,
    inbound_meta: null,
    status: 'enriquecido',
    notas: null,
    hubspot_exported_at: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
    ...over,
  }
}

describe('canSyncToHubspot', () => {
  it('aceita lead com número achado + place_id', () => {
    expect(canSyncToHubspot(baseLead())).toBe(true)
  })

  it('rejeita sem whatsapp_phone', () => {
    expect(canSyncToHubspot(baseLead({ whatsapp_phone: null, whatsapp_status: 'missing' }))).toBe(false)
  })

  it('rejeita se status não for found', () => {
    expect(canSyncToHubspot(baseLead({ whatsapp_status: 'missing' }))).toBe(false)
  })

  it('rejeita sem google_place_id (sem chave de dedup, não sincroniza)', () => {
    expect(canSyncToHubspot(baseLead({ google_place_id: null }))).toBe(false)
  })

  it('rejeita Squad Leads porque são base de aprendizado, não prospecção da Olivia', () => {
    expect(
      canSyncToHubspot(
        baseLead({ google_place_id: 'squad-accidental-key', squad_leads_id: 42, origem: 'squad_leads_form' }),
      ),
    ).toBe(false)
  })

  // O nº manual da dona(o) também destrava o sync: é exatamente o lead que o
  // plano de 10/06 manda preferir no disparo — não pode falhar em silêncio.
  it('aceita lead SÓ com whatsapp_dono (nº manual), sem nº da loja achado', () => {
    expect(
      canSyncToHubspot(
        baseLead({ whatsapp_phone: null, whatsapp_status: 'missing', whatsapp_dono: '+5511988887777' }),
      ),
    ).toBe(true)
  })

  it('whatsapp_dono vazio (ou só espaços) NÃO destrava o gate (anti-invenção)', () => {
    for (const vazio of ['', '   ']) {
      expect(
        canSyncToHubspot(baseLead({ whatsapp_phone: null, whatsapp_status: 'missing', whatsapp_dono: vazio })),
      ).toBe(false)
    }
  })

  it('mesmo com whatsapp_dono, sem place_id não sincroniza (dedup obrigatório)', () => {
    expect(
      canSyncToHubspot(
        baseLead({
          whatsapp_phone: null,
          whatsapp_status: 'missing',
          whatsapp_dono: '+5511988887777',
          google_place_id: null,
        }),
      ),
    ).toBe(false)
  })
})

describe('hubspotDedupValue', () => {
  it('usa só Place ID de Google para dedup de prospecção', () => {
    expect(hubspotDedupValue(baseLead())).toBe('ChIJ_place_123')
    expect(hubspotDedupValue(baseLead({ google_place_id: null, squad_leads_id: 42 }))).toBeNull()
  })
})

describe('canExportDeal', () => {
  it('rejeita Squad Leads para não criar negócios de prospecção para clientes ativos', () => {
    expect(
      canExportDeal(baseLead({ google_place_id: 'squad-accidental-key', squad_leads_id: 42, origem: 'squad_leads_form' })),
    ).toBe(false)
  })
})

describe('leadToContactProperties', () => {
  it('mapeia os campos essenciais', () => {
    const p = leadToContactProperties(baseLead())
    expect(p[HUBSPOT_DEDUP_PROPERTY]).toBe('ChIJ_place_123')
    expect(p.phone).toBe('+5511963366136')
    expect(p.company).toBe('Pietra Pâtisserie')
    expect(p.city).toBe('São Paulo')
    expect(p.website).toBe('http://www.instagram.com/pietrapatisserie')
    expect(p.lifecyclestage).toBe('lead')
  })

  it('não cria chave HubSpot para Squad Leads de aprendizado', () => {
    const p = leadToContactProperties(baseLead({ google_place_id: null, squad_leads_id: 42 }))
    expect(HUBSPOT_DEDUP_PROPERTY in p).toBe(false)
  })

  it('usa dono_nome como firstname quando existe', () => {
    const p = leadToContactProperties(baseLead({ dono_nome: 'Maria Silva' }))
    expect(p.firstname).toBe('Maria Silva')
  })

  it('NÃO inventa: campos nulos são omitidos (não viram string vazia)', () => {
    const p = leadToContactProperties(
      baseLead({ dono_nome: null, website: null, cidade: null }),
    )
    expect('firstname' in p).toBe(false)
    expect('website' in p).toBe(false)
    expect('city' in p).toBe(false)
  })

  it('inclui o handle do Instagram só quando presente', () => {
    expect(leadToContactProperties(baseLead()).instagram_handle).toBe('pietrapatisserie')
    expect('instagram_handle' in leadToContactProperties(baseLead({ instagram_handle: null }))).toBe(false)
  })

  it('sempre inclui a chave de dedup (place_id)', () => {
    const p = leadToContactProperties(baseLead())
    expect(p[HUBSPOT_DEDUP_PROPERTY]).toBeTruthy()
  })

  it('preenche hs_whatsapp_phone_number (o que o WhatsApp do HubSpot usa p/ enviar + opt-in)', () => {
    const p = leadToContactProperties(baseLead({ whatsapp_phone: '+5511963366136' }))
    expect(p[HUBSPOT_WHATSAPP_PHONE_PROPERTY]).toBe('+5511963366136')
  })

  it('inclui nome_genero quando definido (para o workflow ramificar f/m)', () => {
    expect(leadToContactProperties(baseLead({ nome_genero: 'm' })).nome_genero).toBe('m')
    expect(leadToContactProperties(baseLead({ nome_genero: 'f' })).nome_genero).toBe('f')
  })

  it('omite nome_genero quando nulo (anti-invenção)', () => {
    expect('nome_genero' in leadToContactProperties(baseLead({ nome_genero: null }))).toBe(false)
  })

  it('inclui setor_grupo p/ o workflow por segmento ramificar (template por perfil)', () => {
    expect(leadToContactProperties(baseLead()).setor_grupo).toBe('doces')
    expect(leadToContactProperties(baseLead({ setor: 'Academia' })).setor_grupo).toBe('generic')
    // sem setor → generic (copy genérica é segura p/ qualquer negócio)
    expect(leadToContactProperties(baseLead({ setor: null })).setor_grupo).toBe('generic')
  })

  it('grava o setor cru como coluna (p/ o time filtrar no HubSpot)', () => {
    expect(leadToContactProperties(baseLead({ setor: 'Pizzaria' })).setor).toBe('Pizzaria')
    // anti-invenção: setor nulo é omitido (não vira string vazia)
    expect('setor' in leadToContactProperties(baseLead({ setor: null }))).toBe(false)
  })

  // WhatsApp da dona(o): nº pessoal preenchido MANUALMENTE pelo time tem
  // preferência sobre o nº da loja no disparo (decisão LGPD do plano de 10/06).
  it('prefere whatsapp_dono em phone e hs_whatsapp_phone_number quando presente', () => {
    const p = leadToContactProperties(baseLead({ whatsapp_dono: '+5511988887777' }))
    expect(p.phone).toBe('+5511988887777')
    expect(p[HUBSPOT_WHATSAPP_PHONE_PROPERTY]).toBe('+5511988887777')
  })

  it('sem whatsapp_dono, continua usando whatsapp_phone (nº da loja)', () => {
    const p = leadToContactProperties(baseLead({ whatsapp_dono: null }))
    expect(p.phone).toBe('+5511963366136')
    expect(p[HUBSPOT_WHATSAPP_PHONE_PROPERTY]).toBe('+5511963366136')
  })

  it('whatsapp_dono vazio (ou só espaços) é tratado como ausente (anti-invenção)', () => {
    for (const vazio of ['', '   ']) {
      const p = leadToContactProperties(baseLead({ whatsapp_dono: vazio }))
      expect(p.phone).toBe('+5511963366136')
      expect(p[HUBSPOT_WHATSAPP_PHONE_PROPERTY]).toBe('+5511963366136')
    }
  })
})

describe('leadToContactPropertiesWithTrigger', () => {
  it('marca whatsapp_outreach=ready quando trigger=true', () => {
    const p = leadToContactPropertiesWithTrigger(baseLead(), true)
    expect(p[HUBSPOT_OUTREACH_PROPERTY]).toBe(HUBSPOT_OUTREACH_READY)
    // ainda traz o mapeamento normal
    expect(p[HUBSPOT_DEDUP_PROPERTY]).toBe('ChIJ_place_123')
    expect(p.phone).toBe('+5511963366136')
  })

  it('NÃO marca o gatilho quando trigger=false (só sincroniza)', () => {
    const p = leadToContactPropertiesWithTrigger(baseLead(), false)
    expect(HUBSPOT_OUTREACH_PROPERTY in p).toBe(false)
  })
})

describe('Olivia HubSpot reporting properties', () => {
  it('marca disparo acionado usando data em formato aceito pelo HubSpot', () => {
    const props = leadToOliviaReportingProperties(
      baseLead({ whatsapp_sent_at: '2026-06-15T12:00:00Z' }),
    )

    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.disparoStatus]).toBe('triggered')
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.disparadoEm]).toBe(String(Date.parse('2026-06-15T12:00:00Z')))
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.reuniaoStatus]).toBe('none')
  })

  it('marca resposta sem depender de status de entrega do HubSpot', () => {
    const props = leadToOliviaReportingProperties(
      baseLead({ whatsapp_sent_at: '2026-06-15T12:00:00Z', whatsapp_send_status: 'replied' }),
      { respostaEm: '2026-06-15T12:07:00Z' },
    )

    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.disparoStatus]).toBe('replied')
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.respostaEm]).toBe(String(Date.parse('2026-06-15T12:07:00Z')))
  })

  it('mapeia reunião agendada com link, título e responsável Inner', () => {
    const props = buildOliviaReportingPatchBody(
      baseLead({
        reuniao_at: '2026-06-16T15:00:00Z',
        reuniao_link: 'https://meet.google.com/abc-defg-hij',
        reuniao_calendar_title: 'Squad + Pietra Pâtisserie',
        olivia_assigned_rep_nome: 'Ana Inner',
        olivia_assigned_rep_email: 'ana@innerai.com',
        prospect_email: 'maria@example.com',
      }),
    ).properties

    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.reuniaoStatus]).toBe('scheduled')
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.reuniaoEm]).toBe(String(Date.parse('2026-06-16T15:00:00Z')))
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.reuniaoLink]).toBe('https://meet.google.com/abc-defg-hij')
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.reuniaoTitulo]).toBe('Squad + Pietra Pâtisserie')
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.innerResponsavelNome]).toBe('Ana Inner')
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.innerResponsavelEmail]).toBe('ana@innerai.com')
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.prospectEmail]).toBe('maria@example.com')
  })

  it('marca reunião pendente quando falta email para o convite', () => {
    const props = leadToOliviaReportingProperties(
      baseLead({
        olivia_pending_slot_iso: '2026-06-16T15:00:00Z',
        olivia_pending_rep_nome: 'Bruno Inner',
        olivia_pending_rep_email: 'bruno@innerai.com',
      }),
    )

    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.reuniaoStatus]).toBe('pending_email')
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.innerResponsavelNome]).toBe('Bruno Inner')
    expect(props[HUBSPOT_OLIVIA_REPORTING_PROPERTIES.innerResponsavelEmail]).toBe('bruno@innerai.com')
  })
})

describe('reply write-back contact selection', () => {
  it('prefere o hubspot_contact_id do lead e usa associatedContactId só como fallback', () => {
    expect(hubspotReplyContactCandidates('lead-contact', 'thread-contact')).toEqual([
      'lead-contact',
      'thread-contact',
    ])
    expect(hubspotReplyContactCandidates(' same-contact ', 'same-contact')).toEqual(['same-contact'])
    expect(hubspotReplyContactCandidates(null, 'thread-contact')).toEqual(['thread-contact'])
  })

  it('tenta o contato alternativo uma vez quando o primeiro PATCH retorna 404', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const id = String(url).split('/').at(-1)
      return new Response('{}', { status: id === 'lead-contact' ? 404 : 200 })
    })

    try {
      const result = await patchHubspotReplyOutreach(
        'token-teste',
        hubspotReplyContactCandidates('lead-contact', 'thread-contact'),
        'test-reply',
        fetchMock as unknown as typeof fetch,
      )

      expect(result).toMatchObject({
        ok: true,
        contactId: 'thread-contact',
        attemptedContactIds: ['lead-contact', 'thread-contact'],
        status: 200,
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('responsible contact handoff', () => {
  it('monta contato separado com número WhatsApp e gatilho, sem chave do contato original', () => {
    const props = responsibleContactProperties({
      numero: '+5511999002121',
      nome: 'Carolline',
      lead: baseLead({ nome: 'Pietra Pâtisserie', setor: 'Confeitaria', nome_genero: 'f' }),
    })

    expect(props.firstname).toBe('Carolline')
    expect(props.phone).toBe('+5511999002121')
    expect(props.mobilephone).toBe('+5511999002121')
    expect(props[HUBSPOT_WHATSAPP_PHONE_PROPERTY]).toBe('+5511999002121')
    expect(props[HUBSPOT_OUTREACH_PROPERTY]).toBe(HUBSPOT_OUTREACH_READY)
    expect(props.company).toBe('Pietra Pâtisserie')
    expect(props[HUBSPOT_SETOR_GRUPO_PROPERTY]).toBe('doces')
    expect(HUBSPOT_DEDUP_PROPERTY in props).toBe(false)
  })

  it('cai no workflow genérico/feminino quando segmento/gênero estão ausentes', () => {
    const props = responsibleContactProperties({
      numero: '+554898005386',
      nome: null,
      lead: baseLead({ setor: null, nome_genero: null }),
    })

    expect(props.nome_genero).toBe('f')
    expect(props.setor_grupo).toBe('generic')
    expect('setor' in props).toBe(false)
    expect('firstname' in props).toBe(false)
  })

  it('busca contato responsável por WhatsApp, phone ou mobilephone em E.164 exato', () => {
    expect(buildResponsibleContactSearchBody('+5511999002121')).toEqual({
      filterGroups: [
        { filters: [{ propertyName: HUBSPOT_WHATSAPP_PHONE_PROPERTY, operator: 'EQ', value: '+5511999002121' }] },
        { filters: [{ propertyName: 'phone', operator: 'EQ', value: '+5511999002121' }] },
        { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: '+5511999002121' }] },
      ],
      properties: [
        'firstname',
        'phone',
        'mobilephone',
        HUBSPOT_WHATSAPP_PHONE_PROPERTY,
        HUBSPOT_OUTREACH_PROPERTY,
        HUBSPOT_DEDUP_PROPERTY,
      ],
      limit: 10,
    })
  })

  it('monta bodies de escrita e associação sem tocar no contact id original', () => {
    const writeBody = buildResponsibleContactWriteBody({
      numero: '+5511999002121',
      nome: 'Carolline',
      lead: baseLead({ hubspot_contact_id: 'original-contact', hubspot_deal_id: 'deal-1' }),
    })

    expect(writeBody.properties.phone).toBe('+5511999002121')
    expect(writeBody.properties[HUBSPOT_OUTREACH_PROPERTY]).toBe(HUBSPOT_OUTREACH_READY)
    expect(JSON.stringify(writeBody)).not.toContain('original-contact')
    expect(buildContactToDealAssociationBody()).toEqual([
      { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 4 },
    ])
  })

  it('não reutiliza o contato original quando a busca por telefone o retorna', () => {
    expect(
      reusableResponsibleContactId(
        [{ id: 'original-contact' }, { id: 'responsible-contact' }],
        'original-contact',
      ),
    ).toBe('responsible-contact')
    expect(reusableResponsibleContactId([{ id: 'original-contact' }], 'original-contact')).toBeNull()
  })

  it('não reutiliza outro contato original encontrado pelo mesmo telefone', () => {
    expect(
      reusableResponsibleContactId(
        [
          { id: 'other-original', properties: { [HUBSPOT_DEDUP_PROPERTY]: 'place-123' } },
          { id: 'responsible-contact', properties: { [HUBSPOT_DEDUP_PROPERTY]: null } },
        ],
        'current-original',
      ),
    ).toBe('responsible-contact')
    expect(
      reusableResponsibleContactId(
        [{ id: 'other-original', properties: { [HUBSPOT_DEDUP_PROPERTY]: 'place-123' } }],
        'current-original',
      ),
    ).toBeNull()
  })

  it('PATCH de contato existente não sobrescreve identidade CRM sensível', () => {
    const patchBody = buildResponsibleContactPatchBody({
      numero: '+5511999002121',
      nome: 'Carolline',
      lead: baseLead({ nome: 'Pietra Pâtisserie', cidade: 'São Paulo' }),
    })

    expect(patchBody.properties.phone).toBe('+5511999002121')
    expect(patchBody.properties[HUBSPOT_OUTREACH_PROPERTY]).toBe(HUBSPOT_OUTREACH_READY)
    expect('firstname' in patchBody.properties).toBe(false)
    expect('company' in patchBody.properties).toBe(false)
    expect('city' in patchBody.properties).toBe(false)
    expect('lifecyclestage' in patchBody.properties).toBe(false)
  })
})

describe('canExportDeal', () => {
  it('aceita com nome + place_id (CNPJ/dono NÃO exigidos)', () => {
    expect(canExportDeal(baseLead({ cnpj: null, dono_nome: null }))).toBe(true)
  })
  it('rejeita sem place_id', () => {
    expect(canExportDeal(baseLead({ google_place_id: null }))).toBe(false)
  })
})

describe('leadToDealProperties', () => {
  it('cria o negócio em Squad Prospects / etapa Prospects', () => {
    const p = leadToDealProperties(baseLead())
    expect(p.dealname).toBe('Pietra Pâtisserie')
    expect(p.pipeline).toBe(HUBSPOT_DEALS_PIPELINE)
    expect(p.dealstage).toBe(HUBSPOT_STAGE_PROSPECTS)
  })
})

describe('deal stage sync contract', () => {
  it('mapeia as fases da Olivia para os IDs reais do pipeline Squad Prospects', () => {
    expect(HUBSPOT_DEAL_STAGE_IDS.localizar_responsavel).toBe(HUBSPOT_STAGE_LOCALIZAR_RESPONSAVEL)
    expect(hubspotDealStageId('respondido_conversando')).toBe(HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO)
    expect(hubspotDealStageId('reuniao_proposta')).toBe(HUBSPOT_STAGE_REUNIAO_PROPOSTA)
    expect(hubspotDealStageId('reuniao_agendada')).toBe(HUBSPOT_STAGE_REUNIAO_AGENDADA)
  })

  it('monta o corpo exato do PATCH de dealstage', () => {
    expect(buildDealStagePatchBody(HUBSPOT_STAGE_REUNIAO_AGENDADA)).toEqual({
      properties: { dealstage: HUBSPOT_STAGE_REUNIAO_AGENDADA },
    })
  })

  it('não permite regredir fases conhecidas do deal', () => {
    expect(shouldSyncDealStage(HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO, HUBSPOT_STAGE_REUNIAO_PROPOSTA)).toBe(true)
    expect(shouldSyncDealStage(HUBSPOT_STAGE_REUNIAO_AGENDADA, HUBSPOT_STAGE_REUNIAO_PROPOSTA)).toBe(false)
    expect(shouldSyncDealStage(HUBSPOT_STAGE_CLOSED_WON, HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO)).toBe(false)
    // Fase desconhecida: mantém compatibilidade e deixa o HubSpot decidir.
    expect(shouldSyncDealStage('stage-custom', HUBSPOT_STAGE_REUNIAO_AGENDADA)).toBe(true)
  })

  it('encontra a fase conhecida mais avançada no histórico do deal', () => {
    expect(
      highestKnownDealStage([
        HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO,
        'stage-custom',
        null,
        HUBSPOT_STAGE_REUNIAO_AGENDADA,
        HUBSPOT_STAGE_REUNIAO_PROPOSTA,
      ]),
    ).toBe(HUBSPOT_STAGE_REUNIAO_AGENDADA)
    expect(highestKnownDealStage(['stage-custom', null, undefined])).toBeNull()
  })

  it('detecta quando a fase atual precisa ser restaurada para a mais avançada', () => {
    expect(shouldRestoreDealStage(HUBSPOT_STAGE_RESPONDIDO_CONVERSANDO, HUBSPOT_STAGE_REUNIAO_AGENDADA)).toBe(true)
    expect(shouldRestoreDealStage(HUBSPOT_STAGE_REUNIAO_AGENDADA, HUBSPOT_STAGE_REUNIAO_PROPOSTA)).toBe(false)
    expect(shouldRestoreDealStage('stage-custom', HUBSPOT_STAGE_REUNIAO_AGENDADA)).toBe(false)
  })
})

describe('lembrete de reunião — data_reuniao / hora_reuniao (fuso SP)', () => {
  // SP é UTC-3 (sem horário de verão desde 2019).
  it('hubspotDateSP usa o DIA no fuso SP, à meia-noite UTC', () => {
    expect(hubspotDateSP('2026-06-25T18:00:00Z')).toBe(String(Date.UTC(2026, 5, 25)))
  })
  it('hubspotDateSP: reunião 21h30 BRT (00:30Z do dia seguinte) NÃO vira o dia seguinte', () => {
    expect(hubspotDateSP('2026-06-26T00:30:00Z')).toBe(String(Date.UTC(2026, 5, 25)))
  })
  it('hubspotDateSP: null/inválido → null (anti-invenção)', () => {
    expect(hubspotDateSP(null)).toBeNull()
    expect(hubspotDateSP('x)x')).toBeNull()
  })
  it('horaReuniaoLabel: "15h" / "21h30" / sem zero à esquerda', () => {
    expect(horaReuniaoLabel('2026-06-25T18:00:00Z')).toBe('15h')
    expect(horaReuniaoLabel('2026-06-26T00:30:00Z')).toBe('21h30')
    expect(horaReuniaoLabel('2026-06-25T12:00:00Z')).toBe('9h')
    expect(horaReuniaoLabel(null)).toBeNull()
  })
})
