import { Space, Input, Select, Tooltip, Button, Dropdown } from 'antd'
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

// Set di campi per contesto: la Dashboard e la Topologia filtrano SINGOLI servizi (barra piena);
// i pannelli aggregati (Costi/Sprechi/Quote) sono per-account, quindi solo Account + Regione.
export const FILTER_FIELDS_FULL = ['name', 'account', 'type', 'status', 'region', 'schedule', 'managed', 'problems', 'presets']
export const FILTER_FIELDS_ACCOUNT = ['account', 'region']

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
  t,
}) {
  const has = (f) => fields.includes(f)
  return (
    <Space style={{ marginBottom: 16 }} wrap size={8}>
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
          value={accountFilter}
          onChange={setAccountFilter}
          options={accountOptions}
          style={{ minWidth: 140 }}
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
    </Space>
  )
}
