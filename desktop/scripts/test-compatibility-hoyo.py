"""Actual 048 HoYoPageUi + reporting modules, isolated service/inner-editor doubles.
No game is started; no installed Manager, account or driver is modified.
"""
import json, os, subprocess, zipfile, hashlib
from pathlib import Path
from playwright.sync_api import sync_playwright
root = Path(__file__).resolve().parents[1]
out = Path(os.environ.get('COMPAT_REVIEW_DIR', str(root / 'build' / 'compatibility-hoyo')))
out.mkdir(parents=True, exist_ok=True)
err = open(out / 'backend-errors.log', 'w')
server = subprocess.Popen(['node', 'test/compatibility/browser-host.cjs'], cwd=root,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, text=True,
    env={**os.environ, 'COMPAT_TEST_OUTPUT': str(out)})
checks = []
def rpc(method, data):
    server.stdin.write(json.dumps({'method': method, 'data': data}) + '\n'); server.stdin.flush()
    value = server.stdout.readline()
    if not value: raise RuntimeError('Test backend exited')
    return json.loads(value)
def check(label, condition):
    assert condition, label
    checks.append(label)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
            headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        page = browser.new_page(viewport={'width': 1180, 'height': 780})
        page.set_default_timeout(4000)
        errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
        page.expose_function('reportingHost', rpc)
        page.set_content('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main class="view"><h1>米哈游游戏 · 隔离界面验证</h1><div id="host"></div></main></body></html>')
        page.add_style_tag(content='''*{box-sizing:border-box}body{margin:0;background:#0c0e10;color:#e4e7e9;font:15px/1.6 system-ui,"Noto Sans CJK SC",sans-serif}main{max-width:1100px;padding:24px;margin:auto}h1{font-size:24px}h3{font-size:17px;margin:6px 0}.game-card{border:1px solid #35414a;border-radius:12px;margin:16px 0;padding:18px;background:#15191d}.game-card-head,.gp-apply-bar,.library-header{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.game-card-head{cursor:pointer}.game-meta{flex:1;min-width:160px}.game-meta p{margin:5px 0;font-size:13px;color:#adbac4;overflow-wrap:anywhere}.game-title{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.badge{font-size:12px;padding:3px 8px;border:1px solid #4a545c;border-radius:8px}.bad{color:#ffb4b4}.button,.expand-arrow{font:inherit;border:1px solid #52616d;border-radius:8px;padding:8px 14px;background:#252c33;color:#e4e7e9;cursor:pointer}.primary{background:#83dd97;color:#092411}.subtle{background:transparent}.card-action,.library-actions{display:flex;gap:8px}.game-detail{margin-top:20px}.gp-apply-bar{background:#202831;padding:14px;border-radius:10px}.gp-apply-bar small{display:block;color:#adbac4}.gp-section{border-top:1px solid #36414b;padding-top:14px;margin-top:14px}.gp-caption{font-size:13px;color:#b5c0c9}.gp-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.gp-field{display:grid;gap:8px}.gp-fact{display:flex;justify-content:space-between;gap:10px}.gp-fact strong{overflow-wrap:anywhere}.gp-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}select{font:inherit;color:inherit;background:#242a31;padding:8px;max-width:100%}.gp-verification{display:flex;gap:20px}.gp-modal{position:fixed;inset:0;background:#000b;display:grid;place-items:center;z-index:100}.gp-modal-card{background:#202831;padding:25px;max-width:80vw}.hoyo-discovery-notes,.hoyo-evidence{color:#bcc6d1}details>summary{cursor:pointer}.hoyo-poster{display:none}.gp-range{display:flex}input[type=range]{min-width:0}button:disabled{opacity:.45;cursor:default}@media(max-width:600px){main{padding:12px}.game-card{padding:12px}.gp-controls{grid-template-columns:1fr}}''')
        page.add_style_tag(content=(root / 'src/renderer/compatibility-panel.css').read_text())
        # This only doubles the nested settings editor and RPC service; the HoYo
        # discovery/selection/render/actions below execute production source.
        for file in ['test/compatibility/browser-fixture.js', 'src/renderer/compatibility-panel.js',
                     'src/renderer/compatibility-integration.js', 'src/renderer/hoyo-page-ui.js']:
            page.add_script_tag(content=(root / file).read_text())
        page.evaluate('''async () => {
          window.flows = [
            {id:'cn',gameId:'sample',name:'绝区零 · 测试客户端',channel:'cn',channelLabel:'国服',exePath:'D:/Games/ZZZ/game.exe',gameVersion:'测试版本',
             phase:'failed',nextAction:'inspect',api:{api:'dx12'},installation:{installed:true,ready:false},error:{message:'测试：加载助手未能启动'},binding:{launcher:{id:'hoyo-cn',path:'D:/HoYoPlay/launcher.exe'}}},
            {id:'global',gameId:'other',name:'绝区零 · 另一测试客户端',channel:'global',channelLabel:'国际服',exePath:'D:/Global/game.exe',
             phase:'failed',nextAction:'inspect',api:{api:'dx12'},installation:{installed:true,ready:false},error:{message:'测试：启动未完成'}}
          ];
          window.actionCalls=[];
          window.api={...fixtureManager,
            hoyoDiscover:async()=>({ok:true,value:{games:structuredClone(flows),launchers:[],warnings:[]}}),
            hoyoInspect:async id=>({ok:true,value:structuredClone(flows.find(x=>x.id===id))}),
            hoyoStart:async id=>{actionCalls.push(['start',id]);return{ok:true,value:structuredClone(flows.find(x=>x.id===id))};}
          };
          window.hoyo=HoYoPageUi.mount(document.querySelector('#host'),api);await hoyo.activate();
        }''')
        report = page.get_by_role('button', name='反馈本次体验', exact=True)
        report.wait_for()
        check('actual failed HoYo workflow shows feedback without mounting settings', page.evaluate('originalMounts.length') == 0 and report.is_visible())
        check('new feedback does not duplicate existing primary action', page.locator('#host button.primary').count() == 1)
        check('feedback makes no launch/install call', page.evaluate('actionCalls.length') == 0)
        page.screenshot(path=str(out / '01-hoyo-failure-feedback.png'), full_page=True)
        report.click(); page.get_by_text('无法启动', exact=True).click()
        page.locator('textarea').fill('助手无法启动，画面设置没有出现。')
        page.evaluate('hoyo.refresh()')
        check('actual workflow rerender preserves in-progress ratings and note', page.locator('dialog[open]').count() == 1 and page.locator('textarea').input_value().startswith('助手'))
        page.get_by_role('button', name='预览反馈包').click()
        page.get_by_role('button', name='确认并保存反馈包').wait_for()
        check('failed-workflow report uses existing adapter and explicit manual snapshot', '当前配置快照' in page.locator('.cx-summary').first.inner_text())
        page.get_by_role('button', name='确认并保存反馈包').click()
        page.get_by_text('反馈包已保存。请将 ZIP 发给测试群管理员。').wait_for()
        packages = list(out.glob('compat-*.zip'))
        check('failed-workflow ZIP was really written', bool(packages))
        with zipfile.ZipFile(max(packages, key=lambda x: x.stat().st_mtime)) as archive:
            check('independent ZIP CRC passes', archive.testzip() is None)
            data = json.loads(archive.read('report.json'))
            check('user cannot-start rating retained without invented crash cause', data['ratings']['playability'] == 'cannot-start' and data['outcome']['exitKind'] == 'unknown')
        for phase in ['recovery', 'waiting-helper', 'waiting-launcher', 'waiting-game', 'running', 'install']:
            page.evaluate('''async phase=>{flows[0].phase=phase;flows[0].error=null;flows[0].nextAction=phase==='recovery'?'recover':phase==='install'?'preview-install':'wait';await hoyo.refresh();}''', phase)
            check(phase + ' retains a single feedback entry', report.count() == 1 and report.is_visible())
        page.evaluate('''async()=>{flows[0].phase='ready';flows[0].nextAction='start';flows[0].installation.ready=true;await hoyo.refresh();}''')
        check('ready state mounts the nested editor but still has one feedback entry', page.evaluate('originalMounts.length') == 1 and report.count() == 1)
        check('ready state retains one original start action', page.locator('[data-hoyo-action=start]').count() == 1)
        report.click();page.locator('textarea').fill('保留在当前客户端的备注')
        page.evaluate('''async()=>{flows[0].phase='failed';flows[0].nextAction='inspect';flows[0].error={message:'测试失败'};flows[0].installation.ready=false;await hoyo.refresh();}''')
        check('ready-to-failed transition preserves outer-owned feedback draft', page.locator('textarea').input_value() == '保留在当前客户端的备注')
        page.keyboard.press('Escape')
        page.locator('[data-hoyo-client=global]').click()
        check('switching clients binds the displayed name', '另一测试客户端' in page.locator('.game-card.expanded h3').first.inner_text())
        report.click();check('new client does not inherit the old note', page.locator('textarea').input_value() == '')
        page.evaluate('hoyo.deactivate()')
        check('leaving HoYo view closes the dialog', page.locator('dialog[open]').count() == 0)
        page.evaluate('hoyo.activate()');report.wait_for()
        page.evaluate('''async()=>{flows[1].gameId=null;await hoyo.refresh();}''')
        check('unbound discovery ID is not passed as a fabricated game ID', page.get_by_role('button',name='反馈本次体验').is_visible() is False)
        page.locator('[data-hoyo-client=cn]').click();report.wait_for()
        for width,height in [(900,620),(390,844)]:
            page.set_viewport_size({'width':width,'height':height}); report.click()
            check(str(width)+' dialog has no horizontal overflow', page.locator('dialog[open]').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'))
            check(str(width)+' feedback action remains accessible', page.get_by_role('button',name='预览反馈包').evaluate('(e)=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}'))
            page.screenshot(path=str(out / f'02-hoyo-survey-{width}.png'),full_page=True);page.keyboard.press('Escape')
        page.evaluate('window.mutationCount=0;window.counter=new MutationObserver(r=>mutationCount+=r.length);counter.observe(document.querySelector("#host"),{childList:true,subtree:true});')
        page.wait_for_timeout(100);before=page.evaluate('mutationCount');page.wait_for_timeout(180)
        check('failed state has no new idle mutation loop', before == page.evaluate('mutationCount'))
        page.evaluate('hoyo.dispose()')
        check('dispose removes the new feedback dialogs and footers', page.locator('dialog').count() == 0 and page.locator('.cx-feedback-footer').count() == 0)
        check('no browser exceptions', not errors)
        browser.close()
    result={'passed':len(checks),'scope':'Production HoYoPageUi and new reporting modules. Inner GamePageUi, GPU and service data are isolated doubles. Not full Electron/Windows/game acceptance.','checks':checks}
    (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False))
finally:
    server.terminate()
    try:server.wait(timeout=3)
    except subprocess.TimeoutExpired:server.kill()
    err.close()
