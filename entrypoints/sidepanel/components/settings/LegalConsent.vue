<script setup lang="ts">
/** Shows the optional sync disclosure and captures legal acceptance. */
const props = defineProps<{
  accepted: boolean;
  loaded: boolean;
  termsUrl: string;
  privacyUrl: string;
  openLegalUrl: (url: string) => void;
}>();

const emit = defineEmits<{ 'update:accepted': [accepted: boolean] }>();
const { accepted, loaded, termsUrl, privacyUrl, openLegalUrl } = props;

function updateAccepted(event: Event) {
  emit('update:accepted', (event.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="legal-disclosure">
    <p>
      Notion sync is optional. Inkwell can stay local to this device indefinitely. If you connect
      later, your complete local workspace is uploaded first, then future changes use normal online
      and offline syncing.
    </p>
    <label class="legal-consent">
      <input :checked="accepted" type="checkbox" :disabled="!loaded" @change="updateAccepted" />
      <span>
        I have read and agree to the
        <a
          :href="termsUrl"
          target="_blank"
          rel="noopener noreferrer"
          @click.prevent="openLegalUrl(termsUrl)"
          >Terms</a
        >
        and
        <a
          :href="privacyUrl"
          target="_blank"
          rel="noopener noreferrer"
          @click.prevent="openLegalUrl(privacyUrl)"
          >Privacy Policy</a
        >.
      </span>
    </label>
  </div>
</template>
