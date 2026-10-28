<script setup lang="ts">
import { useId } from 'vue';
withDefaults(defineProps<{ modelValue: boolean; title: string; subtitle?: string; maxWidth?: string | number; persistent?: boolean; busy?: boolean }>(), { maxWidth: 620, persistent: false, busy: false });
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const headingId = useId();
</script>
<template>
  <v-dialog :model-value="modelValue" :max-width="maxWidth" :persistent="persistent || busy" :aria-labelledby="headingId" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card class="app-dialog" border>
      <v-card-title class="dialog-heading"><div><h2 :id="headingId">{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></div><v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭弹窗" :disabled="busy" @click="emit('update:modelValue', false)" /></v-card-title>
      <v-divider />
      <v-card-text class="dialog-content"><slot /></v-card-text>
      <template v-if="$slots.actions"><v-divider /><v-card-actions class="dialog-actions"><slot name="actions" /></v-card-actions></template>
    </v-card>
  </v-dialog>
</template>
