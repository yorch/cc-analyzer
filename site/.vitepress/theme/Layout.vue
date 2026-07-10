<script setup lang="ts">
import DefaultTheme from "vitepress/theme";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <!-- Full-viewport CRT overlay: scanlines + vignette + flicker.
         Purely decorative; pointer-events are disabled in CSS. -->
    <template #layout-top>
      <div class="cc-crt" aria-hidden="true" />
    </template>
  </Layout>
</template>
