-- 0021: removing a project, adding a repository again and deleting an organization are functions of the dashboard API's
-- role only. The browser's roles (anon, authenticated) cannot call them, and fenvix_api can; gh_repositories has excluded_at.
do $$
declare f text;
begin
  foreach f in array array['api_remove_project(uuid)', 'api_restore_repository(bigint)', 'api_delete_organization()'] loop
    assert not has_function_privilege('anon', 'public.' || f, 'EXECUTE'), format('anon may call %s', f);
    assert not has_function_privilege('authenticated', 'public.' || f, 'EXECUTE'), format('authenticated may call %s', f);
    assert not has_function_privilege('fenvix_github_app', 'public.' || f, 'EXECUTE'), format('fenvix_github_app may call %s', f);
    assert has_function_privilege('fenvix_api', 'public.' || f, 'EXECUTE'), format('fenvix_api may not call %s', f);
  end loop;
  assert exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gh_repositories' and column_name = 'excluded_at'),
    'gh_repositories.excluded_at is missing';
  raise notice 'REMOVE DELETE RLS OK';
end $$;
select 'REMOVE DELETE RLS OK';
