import { Input, Select, Tooltip, Button, Dropdown } from 'antd'
import {
  TeamOutlined,
  AppstoreOutlined,
  AlertOutlined,
  GlobalOutlined,
  ClockCircleOutlined,
  DeploymentUnitOutlined,
  WarningOutlined,
  SaveOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { Tabs } from '../ui/index.js'
import './servizi.css'

// Set di campi per contesto: la Dashboard e la Topologia filtrano SINGOLI servizi (barra piena);
// i pannelli aggregati (Costi/Sprechi/Quote) sono per-account, quindi solo Account + Regione.
export const FILTER_FIELDS_FULL = ['name', 'account', 'type', 'status', 'region', 'schedule', 'managed', 'problems', 'presets']
export const FILTER_FIELDS_ACCOUNT = ['account', 'region']
// Servizi: le tendine di prima, senza ricerca e senza il bottone «solo problemi», che sulla pagina
// sono il campo e il chip sopra la lista. Due controlli per la stessa cosa si contraddicono.
export const FILTER_FIELDS_SERVIZI = ['type', 'status', 'account', 'region', 'schedule', 'managed', 'presets']

// Barra filtri condivisa da tutte le pagine. Lo stato vive in App (persiste tra le pagine); qui
// mostriamo solo i controlli richiesti da `fields`, così ogni pagina espone solo i filtri sensati.
export default function FilterBar({
  fields,
  nameQuery,
  setNameQuery,
  accountFilter,
  setAccountFilter,
  typeFilter,
  setTypeFilter,
  statusFilter,
  setStatusFilter,
  regionFilter,
  setRegionFilter,
  scheduleFilter,
  setScheduleFilter,
  managedFilter,
  setManagedFilter,
  problemsOnly,
  setProblemsOnly,
  accountOptions,
  typeOptions,
  statusOptions,
  regionOptions,
  filtersActive,
  resetFilters,
  presets,
  quickPresets,
  applyPreset,
  deletePreset,
  onSavePreset,
  className = '',
  // Ancora per il CSS (su Servizi le tendine si chiudono sul telefono) e per il video demo.
  vista = 'filtri',
  t,
}) {
  const has = (f) => fields.includes(f)
  return (
    <div className={`sv-filtri ${className}`.trim()} data-view={vista}>
      {has('name') && (
        <Input.Search
          allowClear
          size="small"
          placeholder={t('filter.searchName')}
          value={nameQuery}
          onChange={(e) => setNameQuery(e.target.value)}
          style={{ width: 180 }}
        />
      )}
      {has('account') && (
        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder={t('filter.allAccounts')}
          value={accountFilter}
          onChange={setAccountFilter}
          options={accountOptions}
          // La tendina si allarga sul contenuto: le etichette degli account sono scritte da chi
          // configura («Management (payer)»), quindi non c'è una larghezza giusta da indovinare.
          popupMatchSelectWidth={false}
          style={{ minWidth: 150 }}
          suffixIcon={<TeamOutlined />}
        />
      )}
      {has('type') && (
        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder={t('filter.type')}
          value={typeFilter}
          onChange={setTypeFilter}
          options={typeOptions}
          style={{ minWidth: 120 }}
          suffixIcon={<AppstoreOutlined />}
        />
      )}
      {has('status') && (
        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder={t('filter.status')}
          value={statusFilter}
          onChange={setStatusFilter}
          options={statusOptions}
          style={{ minWidth: 120 }}
          suffixIcon={<AlertOutlined />}
        />
      )}
      {has('region') && (
        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder={t('filter.region')}
          value={regionFilter}
          onChange={setRegionFilter}
          options={regionOptions}
          style={{ minWidth: 120 }}
          suffixIcon={<GlobalOutlined />}
        />
      )}
      {has('schedule') && (
        <Tooltip title={t('filter.scheduleTip')}>
          <Select
            size="small"
            value={scheduleFilter}
            onChange={setScheduleFilter}
            style={{ minWidth: 130 }}
            suffixIcon={<ClockCircleOutlined />}
            options={[
              { value: 'all', label: t('filter.schedule.all') },
              { value: 'cron', label: t('filter.schedule.cron') },
              { value: 'ondemand', label: t('filter.schedule.ondemand') },
            ]}
          />
        </Tooltip>
      )}
      {has('managed') && (
        <Tooltip title={t('filter.tfTip')}>
          <Select
            size="small"
            value={managedFilter}
            onChange={setManagedFilter}
            style={{ minWidth: 130 }}
            suffixIcon={<DeploymentUnitOutlined />}
            options={[
              { value: 'all', label: t('filter.tf.all') },
              { value: 'managed', label: t('filter.tf.managed') },
              { value: 'unmanaged', label: t('filter.tf.unmanaged') },
            ]}
          />
        </Tooltip>
      )}
      {has('problems') && (
        <Tooltip title={t('filter.problemsOnly')}>
          <Button
            size="small"
            type={problemsOnly ? 'primary' : 'default'}
            danger={problemsOnly}
            icon={<WarningOutlined />}
            onClick={() => setProblemsOnly((v) => !v)}
          />
        </Tooltip>
      )}
      {filtersActive && (
        <Button type="link" size="small" onClick={resetFilters}>
          {t('filter.reset')}
        </Button>
      )}
      {has('presets') && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              {
                type: 'group',
                label: t('preset.quick'),
                children: quickPresets.map((qp) => ({
                  key: `q_${qp.key}`,
                  label: t(qp.labelKey),
                  onClick: () => applyPreset(qp.filters),
                })),
              },
              { type: 'divider' },
              ...(presets.length
                ? presets.map((p) => ({
                    key: p.name,
                    onClick: () => applyPreset(p.filters),
                    label: (
                      <span
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          minWidth: 170,
                          gap: 16,
                        }}
                      >
                        {p.name}
                        <DeleteOutlined
                          onClick={(e) => {
                            e.stopPropagation()
                            deletePreset(p.name)
                          }}
                          style={{ color: '#bfbfbf' }}
                        />
                      </span>
                    ),
                  }))
                : [{ key: '__none', label: t('preset.none'), disabled: true }]),
              { type: 'divider' },
              { key: '__save', icon: <SaveOutlined />, label: t('preset.save'), onClick: onSavePreset },
            ],
          }}
        >
          <Button size="small" icon={<SaveOutlined />}>
            {t('preset.label')}
          </Button>
        </Dropdown>
      )}
    </div>
  )
}

// La riga sopra la lista di Servizi: la ricerca, i chip di stato col conteggio e, sul telefono, il
// bottone che apre le tendine. I chip sono scorciatoie dei filtri di App (vedi `vociChip` in
// web/servizi.js), non uno stato della pagina: quello che premi qui lo ritrovi scelto nella tendina
// Stato, e viceversa.
export function FiltroServizi({ query, onQuery, voci, attiva, onChip, nTendine = 0, aperti, onApri, t }) {
  return (
    <>
      <div className="sv-tools">
        <input
          className="sv-search"
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t('svc.cerca')}
          aria-label={t('svc.cerca')}
        />
        {/* Solo sul telefono (vedi servizi.css): sopra i 720px le tendine stanno sempre aperte. Il
            numero dice quante sono scelte, perche' chiuse non si vedono. */}
        <button type="button" className="ui-kbd sv-filtri-btn" aria-expanded={Boolean(aperti)} onClick={onApri}>
          {nTendine ? t('svc.filtri.n', { n: nTendine }) : t('svc.filtri')}
        </button>
      </div>
      <Tabs voci={voci} attiva={attiva} onCambia={onChip} />
    </>
  )
}
