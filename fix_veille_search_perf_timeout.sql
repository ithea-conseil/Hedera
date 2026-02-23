-- Fix: statement timeout pour veille_search_perf
-- Problème : error 57014 "canceling statement due to statement timeout" avec lim=500
-- Solution : ajouter `set statement_timeout = '30s'` dans la signature de la fonction
--
-- INSTRUCTIONS :
-- 1. Exécuter d'abord la requête ci-dessous pour récupérer la définition complète actuelle
-- 2. Copier le résultat, ajouter la ligne `set statement_timeout = '30s'` avant le AS $$
-- 3. Exécuter le CREATE OR REPLACE FUNCTION modifié

-- Étape 1 : récupérer la définition existante
select pg_get_functiondef(oid)
from pg_proc
where proname = 'veille_search_perf'
  and pronamespace = (select oid from pg_namespace where nspname = 'api');

-- Étape 2 : appliquer le correctif
-- Remplacer <BODY_EXISTANT> par le corps de la fonction récupéré à l'étape 1
-- La seule modification est l'ajout de `set statement_timeout = '30s'`

/*
create or replace function api.veille_search_perf(
  q        text    default null,
  q_mode   text    default 'web',
  awardee  text[]  default null,
  lim      integer default 50,
  off      integer default 0
)
returns jsonb
language plpgsql
security definer
set statement_timeout = '30s'    -- ← ligne ajoutée
as $$
<BODY_EXISTANT>
$$;
*/

-- Optionnel : si la requête reste lente même avec 30s,
-- supprimer le champ "donneesActuelles" du SELECT dans rows_full.
-- Ce champ n'est pas utilisé par le frontend (veille.js) et est le principal
-- responsable de la lenteur de sérialisation JSONB pour 500 lignes.
