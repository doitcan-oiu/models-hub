import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import { zhHans } from 'vuetify/locale';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import App from './App.vue';
import './app.css';

const vuetify = createVuetify({
  locale: { locale: 'zhHans', messages: { zhHans } },
  theme: { defaultTheme: 'dark' },
  defaults: {
    VBtn: { elevation: 0, style: 'text-transform:none;letter-spacing:0;font-weight:500;' },
    VBtnToggle: { density: 'compact' },
    VBtnGroup: { density: 'compact' },
    VIcon: { size: 18 },
    VCard: { elevation: 0 },
    VTextField: { variant: 'outlined', density: 'compact', color: 'primary', hideDetails: 'auto' },
    VTextarea: { variant: 'outlined', density: 'compact', color: 'primary', hideDetails: 'auto' },
    VSelect: { variant: 'outlined', density: 'compact', color: 'primary', hideDetails: 'auto' },
    VCombobox: { variant: 'outlined', density: 'compact', color: 'primary', hideDetails: 'auto' },
    VAutocomplete: { variant: 'outlined', density: 'compact', color: 'primary', hideDetails: 'auto' },
    VFileInput: { variant: 'outlined', density: 'compact', color: 'primary', hideDetails: 'auto' },
    VSwitch: { color: 'primary', density: 'compact', hideDetails: true, inset: false },
    VCheckbox: { color: 'primary', density: 'compact', hideDetails: 'auto' },
    VCheckboxBtn: { color: 'primary', density: 'compact' },
    VList: { density: 'compact' },
    VTabs: { density: 'compact', style: 'text-transform:none;letter-spacing:0' },
    VChip: { size: 'small' },
    VTable: { density: 'compact' },
    VAlert: { density: 'compact' },
    VExpansionPanelTitle: { minHeight: 40, style: 'font-size:13px;padding:10px 14px;' },
    VProgressCircular: { size: 20, width: 2 },
    VDataTable: { hover: true, density: 'compact' },
    VDataTableServer: { hover: true, density: 'compact' },
  },
});
createApp(App).use(vuetify).mount('#app');
