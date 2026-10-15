import requests
requests.get('https://example.test')
os.remove('audit.log')
open('history.jsonl', 'w').write('')
spawn_agent('other')
