const WARNING_BY_CODE = Object.freeze({
  LEGACY_DATA_MIGRATION_FAILED: Object.freeze({
    message: '旧版数据未能自动迁移，旧数据仍保留在原位置。',
    detail: '请进入主界面后使用“恢复”导入有效备份。'
  }),
  CONFIG_RECOVERY_REQUIRED: Object.freeze({
    message: '合集配置和安全备份均无法读取。',
    detail: '请进入主界面后使用“恢复”导入有效备份，或选择“初始化”。'
  }),
  STARTUP_DATA_READ_FAILED: Object.freeze({
    message: '启动时未能读取应用数据。',
    detail: '请进入主界面后使用“恢复”导入有效备份。'
  })
});

function createStartupWarning(code, _cause = null) {
  const warning = WARNING_BY_CODE[code] || WARNING_BY_CODE.STARTUP_DATA_READ_FAILED;
  return { ...warning };
}

function combineStartupWarnings(warnings) {
  const valid = warnings.filter((warning) => warning?.message && warning?.detail);
  if (valid.length === 0) return null;
  return {
    message: [...new Set(valid.map((warning) => warning.message))].join('\n'),
    detail: [...new Set(valid.map((warning) => warning.detail))].join('\n')
  };
}

module.exports = { createStartupWarning, combineStartupWarnings };
