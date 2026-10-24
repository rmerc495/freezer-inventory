create or replace function private.spelling_difference(a text,b text) returns text
language plpgsql immutable strict set search_path='' as $$
declare i integer:=1; n integer:=char_length(a); m integer:=char_length(b);
  a_words text[]:=string_to_array(a,' '); b_words text[]:=string_to_array(b,' ');
begin
  if a=b or least(n,m)<5 or greatest(n,m)>200 or abs(n-m)>1
    or a!~'^[a-z]+( [a-z]+)*$' or b!~'^[a-z]+( [a-z]+)*$'
    or cardinality(string_to_array(a,' '))<>cardinality(string_to_array(b,' ')) then return null; end if;
  for word_index in 1..cardinality(a_words) loop
    if a_words[word_index]<>b_words[word_index] and least(char_length(a_words[word_index]),char_length(b_words[word_index]))<5 then return null; end if;
  end loop;
  if n>m then return private.spelling_difference(b,a); end if;
  while i<=n and substr(a,i,1)=substr(b,i,1) loop i:=i+1; end loop;
  if n=m then
    if substr(a,i,1)=substr(b,i+1,1) and substr(a,i+1,1)=substr(b,i,1)
      and substr(a,i+2)=substr(b,i+2) then return 'transpose'; end if;
    if substr(a,i+1)=substr(b,i+1) then return 'edit'; end if;
  elsif substr(a,i)=substr(b,i+1) then
    if substr(b,i,1)=substr(b,i-1,1) or substr(b,i,1)=substr(b,i+1,1) then return 'repeat'; end if;
    return 'edit';
  end if;
  return null;
end;
$$;
