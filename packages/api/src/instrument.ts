import { initOtel } from '@ledger/shared';

// Must be imported before any other module so the OTel SDK can patch require hooks.
initOtel('ledger-api');
