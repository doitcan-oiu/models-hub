import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";

export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  // Prebundle auto-imported components so visiting a lazy page does not reload drafts.
  optimizeDeps: {
    include: [
      "vuetify/components/VAlert",
      "vuetify/components/VApp",
      "vuetify/components/VAppBar",
      "vuetify/components/VAutocomplete",
      "vuetify/components/VAvatar",
      "vuetify/components/VBtn",
      "vuetify/components/VBtnToggle",
      "vuetify/components/VCard",
      "vuetify/components/VCheckbox",
      "vuetify/components/VChip",
      "vuetify/components/VCombobox",
      "vuetify/components/VDataTable",
      "vuetify/components/VDialog",
      "vuetify/components/VDivider",
      "vuetify/components/VExpansionPanel",
      "vuetify/components/VFileInput",
      "vuetify/components/VForm",
      "vuetify/components/VGrid",
      "vuetify/components/VIcon",
      "vuetify/components/VImg",
      "vuetify/components/VList",
      "vuetify/components/VMain",
      "vuetify/components/VMenu",
      "vuetify/components/VNavigationDrawer",
      "vuetify/components/VPagination",
      "vuetify/components/VProgressCircular",
      "vuetify/components/VProgressLinear",
      "vuetify/components/VSelect",
      "vuetify/components/VSlider",
      "vuetify/components/VSnackbar",
      "vuetify/components/VSwitch",
      "vuetify/components/VTable",
      "vuetify/components/VTabs",
      "vuetify/components/VTextField",
      "vuetify/components/VTextarea",
      "vuetify/components/VTimeline",
      "vuetify/components/transitions",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/v1": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/v1beta": { target: "http://127.0.0.1:8787", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (!path.includes("/node_modules/")) return;
          if (path.includes('/node_modules/@vue/') || path.includes('/node_modules/vue/')) return 'vue';
          if (path.includes('/node_modules/vuetify/')) return 'vuetify';
          if (path.includes('/node_modules/chart.js/') || path.includes('/node_modules/vue-chartjs/')) return 'charts';
          return "vendor";
        },
      },
    },
  },
});
