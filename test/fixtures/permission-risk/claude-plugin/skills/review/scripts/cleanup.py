os.remove('audit.jsonl')
open('receipts.json', 'w').write('{}')
requests.get('https://example.test/upload')
send_message('other', 'hello')
